import express from 'express';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import alawmulaw from 'alawmulaw';
const { MuLaw } = alawmulaw;

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
  let streamSid = null;

  // Connect to OpenAI Realtime
  const aiWs = new WebSocket(OPENAI_WS, {
    headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY }
  });

  let aiReady = false;
  let pendingCreate = false;

  aiWs.on('open', () => {
    aiReady = true;

    // Prime the assistant with short, call-friendly behavior + audio output
    aiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions:
          `You are a friendly, concise real-estate acquisitions assistant for Better Hands.
           Keep answers to 1–2 short sentences and ask one question at a time.
           The lead is ${leadName || 'there'} regarding ${addr || 'the property'}.`,
        input_audio_format: { type: 'raw', sample_rate: 8000, channels: 1 },
        output_audio_format: { type: 'raw', sample_rate: 8000, channels: 1 },
        modalities: ['audio', 'text'],
        turn_detection: { type: 'server_vad' } // simple barge-in handling
      }
    }));

    console.log('OpenAI Realtime connected');
  });

  // Buffer OpenAI audio frames and send to Twilio as 20ms μ-law chunks
  function sendPcmToTwilio(pcmBufInt16LE) {
    if (!streamSid) return;
    // Convert PCM16 (LE) → Int16Array
    const int16 = new Int16Array(pcmBufInt16LE.buffer, pcmBufInt16LE.byteOffset, pcmBufInt16LE.length / 2);

    // Twilio expects 20ms frames at 8kHz → 160 samples/frame
    const SAMPLES_PER_FRAME = 160;
    for (let i = 0; i < int16.length; i += SAMPLES_PER_FRAME) {
      const slice = int16.subarray(i, Math.min(i + SAMPLES_PER_FRAME, int16.length));
      const ulaw = MuLaw.encode(slice);                  // Buffer μ-law
      const payloadB64 = Buffer.from(ulaw).toString('base64');

      twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: payloadB64 }
      }));
    }
  }

  aiWs.on('message', (msg) => {
    try {
      const ev = JSON.parse(msg.toString());

      // Text traces (handy in Render logs)
      if (ev.type === 'response.output_text.delta') {
        process.stdout.write(ev.delta);
      }
      if (ev.type === 'response.completed') {
        process.stdout.write('\n[AI response completed]\n');
        pendingCreate = false;
      }

      // Handle possible audio event names (the API has used both of these)
      if (ev.type === 'response.output_audio.delta' || ev.type === 'response.audio.delta') {
        // ev.delta is base64 PCM16 LE @ 8kHz, mono
        const pcmBuf = Buffer.from(ev.delta, 'base64');
        sendPcmToTwilio(pcmBuf);
      }
    } catch (e) {
      console.error('AI message parse error', e);
    }
  });

  aiWs.on('close', () => {
    try { twilioWs.close(); } catch(_) {}
  });

  // Twilio → OpenAI
  twilioWs.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === 'start') {
        streamSid = data.start?.streamSid || null;
        console.log('Twilio stream started:', streamSid);
      }

      if (data.event === 'media' && aiReady) {
        const ulawB64 = data.media.payload;
        const ulawBuf = Buffer.from(ulawB64, 'base64');
        const int16 = MuLaw.decode(ulawBuf); // Int16Array PCM16 8kHz
        const pcmBuf = Buffer.from(int16.buffer);

        // Append audio to OpenAI
        aiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: pcmBuf.toString('base64'),
          mime_type: 'audio/raw',
          sample_rate: 8000,
          channels: 1
        }));

        // Commit this chunk
        aiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

        // Ask for a response (debounced)
        if (!pendingCreate) {
          pendingCreate = true;
          aiWs.send(JSON.stringify({ type: 'response.create', response: { instructions: '' } }));
        }
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
wss.on('connection', async (twilioWs, req) => {
  console.log('WS connection from Twilio:', req.url);   // <— add this
  // ... existing code ...

  twilioWs.on('error', (err) => console.error('Twilio WS error', err));
  aiWs.on('error', (err) => console.error('OpenAI WS error', err));
});
