import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy';

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY env var');
}

app.get('/', (_req, res) => res.send('OK'));

// --- WebSocket for Twilio ----------------------------------------------------
const wss = new WebSocketServer({
  server,
  path: '/stream',
  handleProtocols: (protocols) => {
    if (protocols && protocols.includes('audio.twilio.com')) return 'audio.twilio.com';
    return false; // reject non-Twilio
  }
});

wss.on('connection', (twilioWs, req) => {
  console.log('WS connection from Twilio:', req.url || '');

  // Connect to OpenAI Realtime
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  let framesSinceCommit = 0;
  let greeted = false;
  let openaiReady = false;
  let streamSid = '';

  // --- OpenAI events ---------------------------------------------------------
  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime');

    // Make OpenAI speak μ-law at 8k and listen for μ-law at 8k (no conversions)
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: OPENAI_VOICE,
        // reasonable VAD
        turn_detection: { type: 'server_vad', silence_duration_ms: 700 },
        instructions: 'You are a friendly real-estate acquisitions assistant. Keep replies short and conversational.'
      }
    }));

    openaiReady = true;

    // Optional: greet so the caller hears something immediately
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio'],
        instructions: 'Hi! Thanks for picking up. How can I help with your property today?'
      }
    }));
  });

  openaiWs.on('message', (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    // Uncomment to debug everything coming back from OpenAI
    // console.log('OpenAI event:', evt.type);

    // OpenAI may use either of these keys depending on version
    // 1) Newer: 'response.output_audio.delta'
    // 2) Older: 'response.audio.delta'
    const isDeltaNew = evt.type === 'response.output_audio.delta' && typeof evt.delta === 'string';
    const isDeltaOld = evt.type === 'response.audio.delta' && typeof evt.delta === 'string';

    if (isDeltaNew || isDeltaOld) {
      // evt.delta is base64 G.711 μ-law @ 8k
      const muB64 = evt.delta;
      try {
        twilioWs.send(JSON.stringify({
          event: 'media',
          media: { payload: muB64 }
        }));
      } catch (e) {
        console.error('Send to Twilio failed:', e);
      }
    }

    if (evt.type === 'response.created') {
      // Helpful log to confirm the model is trying to speak
      console.log('OpenAI: response created');
    }
    if (evt.type === 'response.completed') {
      console.log('OpenAI: response completed');
    }
    if (evt.type === 'error') {
      console.error('OpenAI error:', evt);
    }
  });

  openaiWs.on('error', (e) => console.error('OpenAI WS error:', e));
  openaiWs.on('close', () => console.log('OpenAI WS closed'));

  // --- Twilio events ---------------------------------------------------------
  twilioWs.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === 'start') {
      streamSid = data.start?.streamSid || '';
      console.log('Twilio stream started:', streamSid);
      return;
    }

    if (data.event === 'media') {
      // Twilio sends 20ms frames of base64 μ-law @ 8k
      if (!openaiReady) return;

      // Push μ-law straight into OpenAI
      openaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: data.media.payload    // base64 g711 μ-law
      }));

      framesSinceCommit++;
      if (framesSinceCommit >= 10) { // ~200ms
        framesSinceCommit = 0;

        // Commit the buffer so the model can process it
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

        // Kick off a response the first time (if not already greeted)
        if (!greeted) {
          greeted = true;
          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: { modalities: ['audio'] }
          }));
        }
      }
      return;
    }

    if (data.event === 'mark') {
      // ignore
      return;
    }

    if (data.event === 'stop') {
      console.log('Twilio stream stopped:', streamSid);
      try { openaiWs.close(); } catch {}
      return;
    }
  });

  twilioWs.on('error', (err) => console.error('Twilio WS error', err));
  twilioWs.on('close', () => {
    console.log('Twilio WS closed');
    try { openaiWs.close(); } catch {}
  });
});

server.listen(PORT, () => {
  console.log('Server listening on :' + PORT);
});
