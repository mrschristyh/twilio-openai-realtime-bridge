import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import pkgMu from 'alawmulaw';
const { MuLaw } = pkgMu;

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

const OPENAI_WS_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview')}`;
const OPENAI_HEADERS = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  'OpenAI-Beta': 'realtime=v1'
};

app.get('/', (_req, res) => res.send('OK'));
app.get('/health', (_req, res) => res.json({ ok: true }));

// --- tiny helpers: resample & base64 ---
function pcm16ToBase64(int16) {
  return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).toString('base64');
}
function base64ToPCM16(b64) {
  const buf = Buffer.from(b64, 'base64');
  // return Int16Array view over the buffer
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}
// Naive upsample 8k -> 16k (linear)
function upsample8kTo16k(int16Mono8k) {
  const src = int16Mono8k;
  const dst = new Int16Array(src.length * 2);
  for (let i = 0; i < src.length - 1; i++) {
    const a = src[i], b = src[i + 1];
    dst[2 * i] = a;
    dst[2 * i + 1] = (a + b) >> 1; // simple linear
  }
  dst[dst.length - 2] = src[src.length - 1];
  dst[dst.length - 1] = src[src.length - 1];
  return dst;
}
// Naive downsample 16k -> 8k (decimate by 2)
function downsample16kTo8k(int16Mono16k) {
  const src = int16Mono16k;
  const dst = new Int16Array(Math.floor(src.length / 2));
  for (let i = 0, j = 0; j < dst.length; i += 2, j++) dst[j] = src[i];
  return dst;
}

// μ-law decode(8k) -> PCM16(8k)
function mulawB64ToPcm16_8k(b64) {
  const mu = Buffer.from(b64, 'base64');
  const pcm = new Int16Array(mu.length);
  for (let i = 0; i < mu.length; i++) pcm[i] = MuLaw.decodeSample(mu[i]);
  return pcm;
}

// PCM16(8k) -> μ-law(8k) -> base64
function pcm16_8k_ToMulawB64(int16) {
  const mu = Buffer.alloc(int16.length);
  for (let i = 0; i < int16.length; i++) mu[i] = MuLaw.encodeSample(int16[i]);
  return mu.toString('base64');
}

// ------------------- WebSocket Bridge -------------------
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
  } catch (e) {
    try { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
    try { socket.destroy(); } catch {}
  }
});

wss.on('connection', async (twilioWs, req) => {
  console.log('WS connection from Twilio:', req.url);
  let streamSid = null;

  // 1) Connect to OpenAI Realtime
  const openaiWs = new (await import('ws')).WebSocket(OPENAI_WS_URL, { headers: OPENAI_HEADERS });

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime');
    // Tell OpenAI we want audio out (PCM16 at 16k)
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['text', 'audio'],
        instructions: 'You are a friendly real-estate acquisitions assistant. Keep replies short and conversational.',
        audio: { voice: 'alloy', format: 'pcm16' }
      }
    }));
  });

  openaiWs.on('message', (raw) => {
    // OpenAI emits a stream of JSON events; we only care about audio deltas.
    try {
      const evt = JSON.parse(raw.toString());
      // Newer realtime may emit chunks as: type = 'response.output_audio.delta'
      if (evt.type === 'response.output_audio.delta' && evt.audio) {
        // evt.audio is base64 PCM16 at 16 kHz
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
      }
      // When OpenAI signals the end, we can mark or just ignore.
    } catch (e) {
      console.error('OpenAI msg parse error', e);
    }
  });

  openaiWs.on('close', () => console.log('OpenAI WS closed'));
  openaiWs.on('error', (e) => console.error('OpenAI WS error', e));

  // 2) Handle Twilio inbound media and forward to OpenAI
  twilioWs.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === 'start') {
      streamSid = data.start?.streamSid || null;
      console.log('Twilio stream started:', streamSid);
      return;
    }

    if (data.event === 'media') {
      if (!openaiWs || openaiWs.readyState !== openaiWs.OPEN) return;
      // Twilio gives μ-law(8k) base64 → decode → upsample to 16k → send to OpenAI
      const pcm8k = mulawB64ToPcm16_8k(data.media.payload);
      const pcm16 = upsample8kTo16k(pcm8k);
      openaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: pcm16ToBase64(pcm16) // base64 PCM16 @16k
      }));
      // Optional: commit periodically so the model speaks sooner
      // openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    }

    if (data.event === 'stop') {
      console.log('Twilio stream stopped');
      try { openaiWs.close(); } catch {}
    }
  });

  twilioWs.on('close', () => { try { openaiWs.close(); } catch {} });
  twilioWs.on('error', (err) => console.error('Twilio WS error', err));
});

server.listen(PORT, () => console.log('Server listening on :' + PORT));
