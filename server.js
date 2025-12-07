import express from 'express';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { MuLaw } from 'alawmulaw';

const OPENAI_WS = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
const PORT = process.env.PORT || 8080;

if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY env var');
  process.exit(1);
}

const app = express();
app.get('/', (_, res) => res.send('OK'));

const server = app.listen(PORT, () => {
  console.log('Server listening on :' + PORT);
});

// WebSocket endpoint for Twilio Media Streams
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/stream')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (twilioWs, req) => {
  const url = new URL(req.url, 'http://x');
  const leadName = url.searchParams.get('name') || '';
  const addr = url.searchParams.get('addr') || '';

  // Connect to OpenAI Realtime
  const aiWs = new WebSocket(OPENAI_WS, {
    headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY }
  });

  aiWs.on('open', () => {
    // Initial instruction (system-style)
    const prompt = `You are a friendly real estate acquisitions assistant (Better Hands).
Keep replies short (1–2 sentences) and ask one question at a time.
Lead name: ${leadName || 'there'}. Address: ${addr || 'the property'}.`;
    aiWs.send(JSON.stringify({
      type: 'response.create',
      response: { instructions: prompt }
    }));
    console.log('OpenAI Realtime connected');
  });

  aiWs.on('message', (msg) => {
    try {
      const ev = JSON.parse(msg.toString());
      // For now, just log notable events to confirm flow
      if (ev.type === 'response.output_text.delta') {
        process.stdout.write(ev.delta);
      } else if (ev.type === 'response.completed') {
        process.stdout.write('\n[AI response completed]\n');
      }
      // TODO: handle audio output when we enable AI→Twilio speaking
    } catch (_) {}
  });

  aiWs.on('close', () => {
    try { twilioWs.close(); } catch(_) {}
  });

  // Twilio → OpenAI (decode μ-law 8k → PCM16 8k, then send to OpenAI)
  twilioWs.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      // Twilio sends: { event: 'start' | 'media' | 'mark' | 'stop', ... }
      if (data.event === 'start') {
        console.log('Twilio stream started:', data.start?.streamSid);
      }

      if (data.event === 'media') {
        // data.media.payload is base64 μ-law at 8kHz, mono
        const ulawB64 = data.media.payload;
        const ulawBuf = Buffer.from(ulawB64, 'base64');

        // Decode μ-law → PCM16 (Int16Array), still 8kHz
        const int16 = MuLaw.decode(ulawBuf); // Int16Array
        const pcmBuf = Buffer.from(int16.buffer);

        // Send as raw PCM16 with explicit sample rate 8000
        aiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: pcmBuf.toString('base64'),
          mime_type: 'audio/raw',
          sample_rate: 8000,
          channels: 1
        }));

        // Commit occasionally to let the model process
        aiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      }

      if (data.event === 'stop') {
        console.log('Twilio stream stopped.');
        try { aiWs.close(); } catch(_) {}
      }
    } catch (e) {
      console.error('WS parse error', e);
    }
  });

  twilioWs.on('close', () => {
    try { aiWs.close(); } catch(_) {}
  });
});
