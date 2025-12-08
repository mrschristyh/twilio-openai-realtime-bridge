import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
const OPENAI_VOICE   = process.env.OPENAI_VOICE || 'alloy';

if (!OPENAI_API_KEY) console.error('❌ Missing OPENAI_API_KEY env var');

app.get('/', (_req, res) => res.send('OK'));

/* ---------- μ-law tools ---------- */
// 20ms μ-law frame at 8kHz = 160 bytes. 0xFF ≈ silence.
const ULawSilence20ms = Buffer.alloc(160, 0xFF).toString('base64');
function ulawSilenceMs(ms = 120) {
  const frames = Math.ceil(ms / 20);
  return Array.from({ length: frames }, () => ULawSilence20ms);
}

/* ---------- WS for Twilio ---------- */
const wss = new WebSocketServer({
  server,
  path: '/stream',
  handleProtocols: (protocols) => {
    if (protocols && protocols.includes('audio.twilio.com')) return 'audio.twilio.com';
    return false;
  }
});

wss.on('connection', (twilioWs, req) => {
  console.log('WS connection from Twilio:', req.url || '');

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );

  let openaiReady = false;
  let greeted = false;
  let sentAnyOpenAiAudio = false;
  let keepAliveTimer = null;

  // Counters for logs
  let twilioFrames = 0;
  let openaiAudioChunks = 0;

  // μ-law keepalive to Twilio so call doesn’t drop before model speaks
  const startKeepAlive = () => {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
      if (!sentAnyOpenAiAudio && twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify({ event: 'media', media: { payload: ULawSilence20ms } }));
      }
    }, 250);
  };
  const stopKeepAlive = () => { if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; } };

  const sendGreeting = (tag='') => {
    if (!openaiReady || greeted) return;
    greeted = true;
    console.log('Triggering greeting', tag ? `(${tag})` : '');
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio','text'],
        instructions: 'Hello! This is the real-estate assistant. Can you hear me okay?'
      }
    }));
  };

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime');

    // Use μ-law pass-through both directions
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format:  'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: OPENAI_VOICE,
        turn_detection: { type: 'server_vad', silence_duration_ms: 700 },
        instructions: 'You are a friendly real-estate acquisitions assistant. Keep replies short and conversational.'
      }
    }));

    // ✅ Prime OpenAI with 120ms of silence so the first commit is never empty
    const silentFrames = ulawSilenceMs(120);
    for (const b64 of silentFrames) {
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
    }
    openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    console.log('Primed OpenAI with 120ms silence & committed');

    openaiReady = true;
    sendGreeting('on open');
  });

  openaiWs.on('message', (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    if (evt.type === 'response.created') {
      console.log('OpenAI: response created');
    } else if (evt.type === 'response.completed') {
      console.log('OpenAI: response completed');
    } else if (evt.type === 'error') {
      console.error('OpenAI error:', evt);
    }

    if (evt.type === 'response.output_audio.delta' && evt.delta) {
      openaiAudioChunks++;
      if (openaiAudioChunks % 5 === 0) console.log('OpenAI audio chunks:', openaiAudioChunks);
      sentAnyOpenAiAudio = true;
      stopKeepAlive();
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify({ event: 'media', media: { payload: evt.delta } }));
      }
    }
  });

  openaiWs.on('error', (e) => console.error('OpenAI WS error:', e));
  openaiWs.on('close', () => console.log('OpenAI WS closed'));

  twilioWs.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === 'start') {
      console.log('Twilio stream started:', data.start?.streamSid);
      twilioFrames = 0;
      openaiAudioChunks = 0;
      sentAnyOpenAiAudio = false;
      startKeepAlive();
      sendGreeting('on twilio start');
    }

    if (data.event === 'media') {
      // Count Twilio frames to confirm inbound audio is arriving
      twilioFrames++;
      if (twilioFrames % 10 === 0) console.log('Twilio frames received:', twilioFrames);

      if (!openaiReady) return;
      // Append inbound μ-law frame into OpenAI buffer
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));

      // Commit every ~200ms (10 * 20ms) *only if we actually got frames*
      if (twilioFrames % 10 === 0) {
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      }
    }

    if (data.event === 'stop') {
      console.log('Twilio stream stopped:', data.stop?.streamSid || '');
      stopKeepAlive();
      try { openaiWs.close(); } catch {}
    }
  });

  twilioWs.on('error', (err) => console.error('Twilio WS error', err));
  twilioWs.on('close', () => {
    console.log('Twilio WS closed');
    stopKeepAlive();
    try { openaiWs.close(); } catch {}
  });
});

server.listen(PORT, () => {
  console.log('Server listening on :' + PORT);
});
