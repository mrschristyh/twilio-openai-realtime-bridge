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
  let oaAudioChunks = 0;

  // μ-law 20ms "silence" (160 samples of 0xFF at 8 kHz)
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

  const sendGreeting = (why='') => {
    if (!openaiReady || greeted) return;
    greeted = true;
    console.log('Triggering greeting', why ? `(${why})` : '');
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio','text'],
        // short, to prove audio flows
        instructions: 'Hello! This is the real-estate assistant. Can you hear me okay?',
      }
    }));
  };

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime');

    // Configure session for μ-law passthrough
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
    sendGreeting('on open');
  });

  openaiWs.on('message', (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    // Log key events so we can see what’s happening
    if (evt.type === 'response.created') {
      console.log('OpenAI: response created');
    } else if (evt.type === 'response.completed') {
      console.log('OpenAI: response completed');
    } else if (evt.type === 'error') {
      console.error('OpenAI error:', evt);
    }

    // OpenAI audio deltas (μ-law base64) come as response.output_audio.delta
    if (evt.type === 'response.output_audio.delta' && evt.delta) {
      oaAudioChunks++;
      if (oaAudioChunks % 5 === 0) console.log('OpenAI audio chunks:', oaAudioChunks);
      sentAnyOpenAiAudio = true;
      stopKeepAlive();
      if (twilioWs.readyState === WebSocket.OPEN) {
        // Forward μ-law base64 straight to Twilio
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
      framesSinceCommit = 0;
      sentAnyOpenAiAudio = false;
      oaAudioChunks = 0;
      startKeepAlive();
      // in case OpenAI was ready first
      sendGreeting('on twilio start');
    }

    if (data.event === 'media') {
      if (!openaiReady) return;
      // append Twilio μ-law frames to OpenAI input buffer
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
      framesSinceCommit++;
      if (framesSinceCommit >= 10) {
        framesSinceCommit = 0;
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        // if somehow we still didn’t greet, do it
        if (!greeted) sendGreeting('after commit');
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
