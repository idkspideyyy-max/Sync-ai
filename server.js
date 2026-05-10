import express from 'express';
import cors from 'cors';
import pLimit from 'p-limit';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serves frontend

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Only the models you want
const GROQ_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant"
];

const OPENROUTER_MODELS = [
  "openai/gpt-oss-20b:free",
  "neversleep/llama-3-lumimaid-8b:free", // owl alpha is usually this
  "openrouter/auto" // free model router
];

const SYNTHESIZER_MODEL = "llama-3.3-70b-versatile";
const SYSTEM_PROMPT = "Your name is Syncron. Answer the user's request directly and concisely.";

const limit = pLimit(3); // 3 concurrent to avoid rate limits

async function callAPI(url, key, model, prompt, provider) {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(provider === "openrouter" && {
          "HTTP-Referer": "https://sync-ai.onrender.com",
          "X-Title": "Sync AI"
        })
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 800
      }),
      signal: AbortSignal.timeout(20000)
    });

    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    const data = await res.json();
    return {
      model,
      provider,
      answer: data.choices[0].message.content,
      latency_ms: Date.now() - start
    };
  } catch (e) {
    return { model, provider, error: e.message, latency_ms: Date.now() - start };
  }
}

const callGroq = (m, p) => callAPI("https://api.groq.com/openai/v1/chat/completions", GROQ_API_KEY, m, p, "groq");
const callOpenRouter = (m, p) => callAPI("https://openrouter.ai/api/v1/chat/completions", OPENROUTER_API_KEY, m, p, "openrouter");

async function synthesize(prompt, responses) {
  const valid = responses.filter(r => r.answer);
  const formatted = valid.map(r => `Model ${r.model}:\n${r.answer}`).join('\n\n---\n\n');

  const synthesisPrompt = `User prompt: "${prompt}"

Here are answers from ${valid.length} AIs named Syncron:

${formatted}

Task: 
1. Merge all answers into ONE structured response. No duplicate points.
2. Use headings and bullets to keep it clean.
3. At the very end add exactly these sections:

**Consensus**: What most of the AIs agreed on
**Minority Views**: What fewer AIs said or unique insights

Do not say you are synthesizing. Output only the final answer.`;

  const result = await callGroq(SYNTHESIZER_MODEL, synthesisPrompt);
  return result.answer || "Synthesis failed";
}

app.post('/api/sync', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  const tasks = [
   ...GROQ_MODELS.map(m => limit(() => callGroq(m, prompt))),
   ...OPENROUTER_MODELS.map(m => limit(() => callOpenRouter(m, prompt)))
  ];

  const responses = await Promise.all(tasks);
  const sync_answer = await synthesize(prompt, responses);

  res.json({
    sync_answer,
    models_used: responses.length,
    models_succeeded: responses.filter(r => r.answer).length,
    raw_responses: responses
  });
});

// Simple frontend served at /
app.get('/', (_, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sync AI</title>
  <style>
    body { font-family: system-ui; max-width: 700px; margin: 20px auto; padding: 0 16px; background: #0f0f0f; color: #eee; }
    textarea { width: 100%; background: #1a1a1a; color: #eee; border: 1px solid #333; border-radius: 8px; padding: 12px; }
    button { width: 100%; padding: 12px; margin-top: 8px; background: #7c3aed; border: none; border-radius: 8px; color: white; font-weight: 600; }
    button:disabled { opacity: 0.5; }
    pre { background: #1a1a1a; padding: 16px; border-radius: 8px; white-space: pre-wrap; border: 1px solid #333; }
    .meta { font-size: 12px; color: #888; margin: 8px 0; }
  </style>
</head>
<body>
  <h1>Sync AI</h1>
  <p class="meta">Ask once, 5 models answer, Llama 70B merges them.</p>
  <textarea id="prompt" rows="4" placeholder="Ask Syncron anything..."></textarea>
  <button id="btn" onclick="run()">Run Sync</button>
  <div id="out"></div>
  <script>
    async function run() {
      const btn = document.getElementById('btn');
      const out = document.getElementById('out');
      const prompt = document.getElementById('prompt').value.trim();
      if (!prompt) return;
      btn.disabled = true;
      btn.innerText = 'Thinking... ~15s';
      out.innerHTML = '';
      try {
        const r = await fetch('/api/sync', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ prompt })
        });
        const data = await r.json();
        out.innerHTML = '<h3>Sync Answer</h3><pre>' + data.sync_answer + '</pre>' +
                        '<div class="meta">' + data.models_succeeded + '/' + data.models_used + ' models responded</div>';
      } catch (e) {
        out.innerHTML = '<pre>Error: ' + e.message + '</pre>';
      }
      btn.disabled = false;
      btn.innerText = 'Run Sync';
    }
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => console.log(`Sync running on ${PORT}`));