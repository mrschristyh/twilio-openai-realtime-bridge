import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
const OPENAI_WS_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
const OPENAI_HEADERS = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  'OpenAI-Beta': 'realtime=v1'
};

app.get('/', (_req, res) => res.send('OK'));
app.get('/health', (_req, res) => res.json({ ok: true }));

/* ------------ μ-law helpers (G.711) ------------ */
const MU_BIAS = 0x84;
const MU_CLIP = 32635;

function pcmSampleToMuLaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > MU_CLIP) sample = MU_CLIP;
  sample = sample + MU_BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  let mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}
function muLawToPcmSample(ulawByte) {
  ulawByte = ~ulawByte & 0xFF;
  const sign = (ulawByte & 0x80);
  const exponent = (ulawByte >> 4) & 0x07;
  const mantissa = ulawByte & 0x0F;
  let sample = ((mantissa << 3) + MU_BIAS) << exponent;
  sample -= MU_BIAS;
  return (sign !== 0) ? -sample : sample;
}
function mulawB64ToPcm16_8k(b64) {
  const mu = Buffer.from(b64, 'base64');
  const out = new Int16Array(mu.length);
  for (let i = 0; i < mu.length; i++) out[i] = muLawToPcmSample(mu[i]);
  return out;
}
function pcm16_8k_ToMulawB64(int16) {
  const mu = Buffer.alloc(int16.length);
  for (let i = 0; i < int16.length; i++) mu[i] = pcmSampleToMuLaw(int16[i]);
  return mu.toString('base64');
}
function pcm16ToBase64(int16) {
  return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).toString('base64');
}
function base64ToPCM16(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}
// naive upsample 8k -> 16k
function upsample8kTo16k(int16Mono8k) {
  const src = int16Mono8k;
  const dst = new Int16Array(src.length * 2);
  for (let i = 0; i < src.length - 1; i++) {
    const a = src[i], b = src[i + 1];
    dst[2 * i] = a;
    dst[2 * i + 1] = (a + b) >> 1;
  }
  dst[dst.length - 2] = src[src.length - 1];
  dst[dst.length - 1] = src[src.length - 1];
  return dst;
}
// naive downsample 16k -> 8k
function downsample16kTo8k(int16Mono16k) {
  const src = int16Mono16k;
  const dst = new Int16Array(Math.floor(src.length / 2));
  for (let i = 0, j = 0; j < dst.length; i += 2, j++) dst[j] = src[i];
  return dst;
}
/* ------------ end μ-law helpers ------------ */

// WS bridge
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/stream') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } catch {
    try { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
    try { socket.destroy(); } catch {}
  }
});

wss.on('connection', async (twilioWs, req) => {
  console.log('WS connection from Twilio:', req.url);
  let streamSid = null;
  let framesSinceCommit = 0;
  let haveGreeted = false;

  // Connect to OpenAI Realtime WS
  const { WebSocket } = await import('ws');
  const openaiWs = new WebSocket(OPENAI_WS_URL, { headers: OPENAI_HEADERS });

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime');
    // 1) Configure session: input format + VAD (turn detection)
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format: { type: 'pcm16', sample_rate_hz: 16000, channels: 1 },
        turn_detection: { type: 'server_vad', silence_duration_ms: 700 },
        // Ask for audio responses by default
        output_audio_format: { type: 'pcm16', sample_rate_hz: 16000 },
        instructions: 'You are a friendly real-estate acquisitions assistant. Keep replies short and conversational.'
      }
    }));

    // 2) Optional: greet quickly so you know it’s alive
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['audio'],
        audio: { voice: 'alloy' },  // model chooses TTS, we’ll receive PCM16
        instructions: 'Say a short hello and ask how you can help about a property.'
      }
    }));
    haveGreeted = true;
  });

  // Log ALL events so we can see what’s coming back
  openaiWs.on('message', (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); }
    catch (e) { console.error('OpenAI parse error', e); return; }

    if (!evt || !evt.type) return;
    // console.log('OpenAI evt:', evt.type);

    // Newer: response.output_audio.delta  (base64 PCM16 @16k)
    if (evt.type === 'response.output_audio.delta' && evt.audio) {
      const pcm16_16k = base64ToPCM16(evt.audio);
      const pcm16_8k = downsample16kTo8k(pcm16_16k);
      const mulawB64 = pcm16_8k_ToMulawB64(pcm16_8k);
      if (streamSid) {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: mulawB64 }
        }));
      }
      return;
    }

    // Older alias some stacks emit: response.audio.delta
    if (evt.type === 'response.audio.delta' && evt.delta) {
      const pcm16_16k = base64ToPCM16(evt.delta);
      const pcm16_8k = downsample16kTo8k(pcm16_16k);
      const mulawB64 = pcm16_8k_ToMulawB64(pcm16_8k);
      if (streamSid) {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: mulawB64 }
        }));
      }
      return;
    }

    if (evt.type === 'response.completed') {
      // end of one spoken turn
      // console.log('OpenAI response completed');
      return;
    }
    if (evt.type === 'error') {
      console.error('OpenAI error:', evt);
    }
  });

  openaiWs.on('close', () => console.log('OpenAI WS closed'));
  openaiWs.on('error', (e) => console.error('OpenAI WS error', e));

  // Twilio -> OpenAI
  twilioWs.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === 'start') {
      streamSid = data.start?.streamSid || null;
      console.log('Twilio stream started:', streamSid);
      framesSinceCommit = 0;
      return;
    }

    if (data.event === 'media') {
      if (!openaiWs || openaiWs.readyState !== openaiWs.OPEN) return;

      // Decode μ-law(8k) -> upsample to 16k -> send as input buffer
      const pcm8k = mulawB64ToPcm16_8k(data.media.payload);
      const pcm16 = upsample8kTo16k(pcm8k);

      openaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: pcm16ToBase64(pcm16) // base64 PCM16 @16k
      }));

      framesSinceCommit++;
      // Commit every few frames so the model can start talking
      if (framesSinceCommit >= 6) {
        framesSinceCommit = 0;
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        // Ask for a response once we’ve committed some audio (if we didn’t greet yet)
        if (!haveGreeted) {
          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['audio'],
              audio: { voice: 'alloy' }
            }
          }));
        }
      }
      return;
    }

    if (data.event === 'mark') {
      return; // ignore
    }

    if (data.event === 'stop') {
      console.log('Twilio stream stopped');
      try { openaiWs.close(); } catch {}
      return;
    }
  });

  twilioWs.on('close', () => { try { openaiWs.close(); } catch {} });
  twilioWs.on('error', (err) => console.error('Twilio WS error', err));
});

server.listen(PORT, () => console.log('Server listening on :' + PORT));
