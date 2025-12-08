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

/* ------------------------------------------------------------------ */
/* μ-law <-> PCM16 helpers (8 kHz)                                    */
/* ------------------------------------------------------------------ */

const MULAW_MAX = 0x1FFF;

function muLawDecodeSample(mu) {
  // ITU-T G.711 μ-law decode to 16-bit PCM
  mu = ~mu & 0xFF;
  let sign = (mu & 0x80);
  let exponent = (mu >> 4) & 0x07;
  let mantissa = mu & 0x0F;
  let magnitude = ((mantissa << 3) + 0x84) << exponent;
  let sample = (magnitude - 0x84);
  if (sign !== 0) sample = -sample;
  // Clamp to 16-bit
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}

function muLawB64ToPCM16(b64) {
  const mu = Buffer.from(b64, 'base64');
  const out = new Int16Array(mu.length);
  for (let i = 0; i < mu.length; i++) out[i] = muLawDecodeSample(mu[i]);
  return Buffer.from(out.buffer);
}

// Very simple μ-law encoder from 16-bit PCM
function muLawEncodeSample(pcm) {
  let sign = (pcm < 0) ? 0x80 : 0x00;
  pcm = Math.abs(pcm);
  if (pcm > 32635) pcm = 32635;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) { /* find exponent */ }

  const mantissa = (pcm >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  const mu = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return mu;
}

function pcm16ToMuLawB64(pcmBuf) {
  const samples = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
  const out = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = muLawEncodeSample(samples[i]);
  return out.toString('base64');
}

/* ------------------------------------------------------------------ */
/* WebSocket server for Twilio                                        */
/* ------------------------------------------------------------------ */

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

  // Connect to OpenAI Realtime WS
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );

  let framesSinceCommit = 0;
  let greeted = false;
  let openaiReady = false;

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime');

    // Configure the session (strings, not objects)
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format: 'pcm16',     // we will send PCM16
        output_audio_format: 'pcm16',    // we want PCM16 back
        voice: OPENAI_VOICE,
        turn_detection: { type: 'server_vad', silence_duration_ms: 700 },
        instructions: 'You are a friendly real-estate acquisitions assistant. Keep replies short and conversational.'
      }
    }));

    openaiReady = true;

    // Optional: greet immediately so user hears a voice
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio'],
        instructions: 'Hello! Thanks for picking up. How can I help regarding your property today?'
      }
    }));
  });

  openaiWs.on('message', (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    // Uncomment to see the stream of events
    // console.log('OpenAI event:', evt.type);

    // When model sends audio deltas (PCM16 base64), forward to Twilio (μ-law)
    if (evt.type === 'response.output_audio.delta' && evt.delta) {
      const pcmB64 = evt.delta; // base64 PCM16
      const pcmBuf = Buffer.from(pcmB64, 'base64');
      const muB64 = pcm16ToMuLawB64(pcmBuf);
      twilioWs.send(JSON.stringify({ event: 'media', media: { payload: muB64 } }));
    }

    // If OpenAI finishes a response, we could prompt for next turn if needed
    // if (evt.type === 'response.completed') { ... }
  });

  openaiWs.on('error', (e) => console.error('OpenAI WS error:', e));
  openaiWs.on('close', () => console.log('OpenAI WS closed'));

  // Handle incoming audio from Twilio
  twilioWs.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === 'start') {
      console.log('Twilio stream started:', data.start?.streamSid);
    }

    if (data.event === 'media') {
      if (!openaiReady) return; // wait for OpenAI WS
      // Twilio provides μ-law base64 @ 8kHz. Convert to PCM16.
      const pcmBuf = muLawB64ToPCM16(data.media.payload);
      const pcmB64 = pcmBuf.toString('base64');

      // Append to OpenAI input buffer
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcmB64 }));

      // Commit about every ~200ms (~10 * 20ms frames)
      framesSinceCommit++;
      if (framesSinceCommit >= 10) {
        framesSinceCommit = 0;
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

        // Trigger a response the first time if we didn't greet
        if (!greeted) {
          greeted = true;
          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: { modalities: ['audio'] }
          }));
        }
      }
    }

    if (data.event === 'stop') {
      console.log('Twilio stream stopped');
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
