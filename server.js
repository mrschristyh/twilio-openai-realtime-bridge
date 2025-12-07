import express from 'express';
import { WebSocketServer } from 'ws';
import { decode as mulawDecode } from 'mulaw-js';
import { Resampler } from 'node-resampler';
import WebSocket from 'ws';

// ENV: set OPENAI_API_KEY
const OPENAI_WS = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview'; // model name may vary
const PORT = process.env.PORT || 8080;

const app = express();

// Health check
app.get('/', (_, res) => res.send('OK'));

// --- WebSocket server for Twilio Media Streams ---
const wss = new WebSocketServer({ noServer: true });

// Upgrade HTTP → WS
const server = app.listen(PORT, () => {
  console.log('Server on :' + PORT);
});
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/stream')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// Helpers: resample μ-law 8 kHz → PCM16 24 kHz (OpenAI)
function ulaw8kToPcm16_24k(base64) {
  const ulawBytes = Buffer.from(base64, 'base64');
  const pcm8k = mulawDecode(ulawBytes); // Int16Array at 8kHz
  const input = Buffer.from(pcm8k.buffer);
  const r = new Resampler({
    inputSampleRate: 8000,
    outputSampleRate: 24000,
    channels: 1,
    bitDepth: 16
  });
  const outBuf = r.resample(input);
  return outBuf; // Buffer PCM16 LE at 24kHz mono
}

// Downsample OpenAI PCM16 24k → μ-law 8k for Twilio
// NOTE: for a first pass, you can skip talking back and just let AI be silent.
// If you want bidirectional speech, implement 24k→8k and PCM→μ-law here.
function pcm24kToUlaw8k(pcm24kBuf) {
  const r = new Resampler({
    inputSampleRate: 24000, outputSampleRate: 8000, channels: 1, bitDepth: 16
  });
  const pcm8k = r.resample(pcm24kBuf);
  // μ-law encode manually (or via a lib). Placeholder:
  // TODO: implement pcm8kInt16 -> mu-law buffer
  return null; // return Buffer of μ-law bytes (or null to skip)
}

// Bridge each Twilio call to one OpenAI Realtime session
wss.on('connection', async (twilioWs, req) => {
  const url = new URL(req.url, 'http://x');
  const leadName = url.searchParams.get('name') || '';
  const addr = url.searchParams.get('addr') || '';

  // Connect to OpenAI Realtime over WS
  const aiWs = new WebSocket(OPENAI_WS, {
    headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY }
  });

  aiWs.on('open', () => {
    // Optional: send a system prompt
    aiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        instructions: `You are a friendly real estate acquisitions assistant (Better Hands).
Keep replies concise (1–2 sentences). Ask one question at a time. Lead name: ${leadName || 'there'}. Address: ${addr || 'the property'}.`
      }
    }));
  });

  // From Twilio → to OpenAI
  twilioWs.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === 'media') {
        // Twilio sends base64 μ-law @8k
        const pcm24k = ulaw8kToPcm16_24k(data.media.payload);
        // Send to OpenAI Realtime as audio chunk
        aiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: Buffer.from(pcm24k).toString('base64'),
          // Some SDKs accept {mime_type:"audio/raw", sample_rate:24000, channels:1}
        }));
        // Commit to force processing occasionally (every ~200ms)
        aiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      }
    } catch (_) {}
  });

  // From OpenAI → to Twilio
  aiWs.on('message', (msg) => {
    try {
      const ev = JSON.parse(msg.toString());
      // When Realtime sends audio chunks, they’re PCM16 @24k in base64
      if (ev.type === 'output_audio.delta' && ev.delta) {
        const pcm24k = Buffer.from(ev.delta, 'base64');
        const ulaw8k = pcm24kToUlaw8k(pcm24k);
        if (ulaw8k) {
          twilioWs.send(JSON.stringify({
            event: 'media',
            media: {
              payload: ulaw8k.toString('base64')
            }
          }));
          // Mark to let Twilio know where this chunk ends (optional)
          twilioWs.send(JSON.stringify({ event: 'mark', mark: { name: 'ai-chunk' } }));
        }
      }
    } catch (_) {}
  });

  // Twilio stream lifecycle
  twilioWs.on('close', () => aiWs.close());
  aiWs.on('close', () => twilioWs.close());
});
