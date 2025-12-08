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

/* ---------- Twilio WS (g711 μ-law end-to-end) ---------- */

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

  // Connect to OpenAI Realtime
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );

  let framesSinceCommit = 0;
  let openaiReady = false;
  let greeted = false;
  let sentAnyOpenAiAudio = false;
  let keepAliveTimer = null;

  // Pre-computed μ-law 20ms silence frame (8 kHz * 0.02s = 160 samples)
  // μ-law "silence" byte is 0xFF; base64 that to ship to Twilio.
  const SILENCE_BASE64 = Buffer.alloc(160, 0xFF).toString('base64');
  const startKeepAlive = () => {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
      if (twilioWs.readyState === WebSocket.OPEN && !sentAnyOpenAiAudio) {
        twilioWs.send(JSON.stringify({ event: 'media', media: { payload: SILENCE_BASE64 } }));
      }
    }, 250);
  };
  const stopKeepAlive = () => { if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; } };

  const sendGreeting = () => {
    if (!openaiReady || greeted) return;
    greeted = true;
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio','text'],
        instructions: 'Hello! Thanks for picking up. How can I help regarding your property today?'
      }
    }));
  };

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime');

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

    openaiReady = true;
    // Kick off greeting ASAP (Twilio might still be starting)
    sendGreeting();
  });

  openaiWs.on('message', (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    if (evt.type === 'response.output_audio.delta' && evt.delta) {
      sentAnyOpenAiAudio = true;     // stop keepalive once model speaks
      stopKeepAlive();
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify({ event: 'media', media: { payload: evt.delta } }));
      }
    }

    // Optional debug:
    // if (evt.type === 'response.created') console.log('OpenAI: response created');
    // if (evt.type === 'error') console.error('OpenAI error:', evt);
  });

  openaiWs.on('error', (e) => console.error('OpenAI WS error:', e));
  openaiWs.on('close', () => console.log('OpenAI WS closed'));

  twilioWs.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === 'start') {
      console.log('Twilio stream started:', data.start?.streamSid);
      framesSinceCommit = 0;
      sentAnyOpenAiAudio = false;
      startKeepAlive();     // keep call open until model audio flows
      // If OpenAI is already ready, (re)send greeting now
      sendGreeting();
    }

    if (data.event === 'media') {
      if (!openaiReady) return;
      // Append Twilio μ-law 20ms frame to OpenAI buffer
      openaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: data.media.payload
      }));
      framesSinceCommit++;

      if (framesSinceCommit >= 10) {
        framesSinceCommit = 0;
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

        // If we haven’t greeted (e.g., no human speech yet), create a response
        if (!greeted) sendGreeting();
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
