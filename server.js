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

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY env var');
}

app.get('/', (_req, res) => res.send('OK'));

/* ------------------------------------------------------------------ */
/* WebSocket server for Twilio                                        */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({
  server,
  path: '/stream',
  // Twilio requires this subprotocol:
  handleProtocols: (protocols) => {
    if (protocols && protocols.includes('audio.twilio.com')) return 'audio.twilio.com';
    return false;
  }
});

wss.on('connection', (twilioWs, req) => {
  console.log('WS connection from Twilio:', req.url || '');

  // Connect to OpenAI Realtime WS
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );

  let framesSinceCommit = 0;
  let hasBufferedAudio = false;  // track whether we actually appended any audio
  let greeted = false;
  let openaiReady = false;

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime');

    // ✅ Use mu-law end-to-end so we can pass audio straight through
    //    (no custom encode/decode needed; 8kHz telephone audio)
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format:  'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        // voice affects output prosody; works with audio+text
        voice: OPENAI_VOICE,
        // Simple VAD so the model knows when to talk
        turn_detection: { type: 'server_vad', silence_duration_ms: 700 },
        instructions: 'You are a friendly real-estate acquisitions assistant. Keep replies short and conversational.'
      }
    }));

    openaiReady = true;

    // Optional: greet so the person hears the AI without needing to speak first
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio','text'],  // <-- MUST include both
        instructions: 'Hello! Thanks for picking up. How can I help regarding your property today?'
      }
    }));
  });

  openaiWs.on('message', (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    // Forward OpenAI audio deltas (μ-law base64) straight to Twilio
    if (evt.type === 'response.output_audio.delta' && evt.delta) {
      twilioWs.send(JSON.stringify({ event: 'media', media: { payload: evt.delta } }));
    }

    // (Optional) logs for debugging:
    // if (evt.type === 'response.created') console.log('OpenAI: response created');
    // if (evt.type === 'response.completed') console.log('OpenAI: response completed');
    // if (evt.type === 'error') console.error('OpenAI error:', evt);
  });

  openaiWs.on('error', (e) => console.error('OpenAI WS error:', e));
  openaiWs.on('close', () => console.log('OpenAI WS closed'));

  // Handle incoming audio from Twilio
  twilioWs.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === 'start') {
      console.log('Twilio stream started:', data.start?.streamSid);
      framesSinceCommit = 0;
      hasBufferedAudio = false;
    }

    if (data.event === 'media') {
      if (!openaiReady) return;
      // Twilio sends 20ms μ-law frames, base64-encoded, at 8kHz.
      // We pass them straight to OpenAI.
      openaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: data.media.payload
      }));

      hasBufferedAudio = true;
      framesSinceCommit++;

      // Commit roughly every 10 frames (~200ms) to keep latency low.
      if (framesSinceCommit >= 10) {
        framesSinceCommit = 0;
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

        // Trigger the first response after we have some audio, if we didn't greet
        if (!greeted) {
          greeted = true;
          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: { modalities: ['audio','text'] }
          }));
        }
      }
    }

    if (data.event === 'mark') {
      // Not needed, but available if you want markers
    }

    if (data.event === 'stop') {
      console.log('Twilio stream stopped:', data.stop?.streamSid || '');
      try { openaiWs.close(); } catch {}
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
