/* Sedra Electric — AI chat (Cloudflare Pages Function, free Workers AI)
   Route: POST /api/chat   Body: { messages:[{role,content}], lang, sid?, stream?, ts_token? }
   - Requires a Workers-AI binding named "AI".
   - Optional env vars (Pages > Settings > Variables):
       MODEL           force a specific model id
       SYSTEM_PROMPT   override the assistant's knowledge/voice without editing code
       LEAD_DB_URL     Firebase RTDB base url for saving chat transcripts (default below)
       CHATS_NODE      RTDB node for transcripts (default "chats")
       TURNSTILE_SECRET  if set, requires a valid Cloudflare Turnstile token (anti-spam)
   - Optional binding: RATE_KV (KV namespace) → simple per-IP rate limit. */

const SYSTEM_DEFAULT = `You are "Sedra Assistant" — the smart, friendly assistant on the Sedra Electric website. You represent the brand and talk in Sedra's voice: confident, warm, engineering-led, helpful, and human. Keep answers concise and useful. Never sound robotic.

LANGUAGE: Reply in the SAME language the visitor uses. For Arabic, use natural EGYPTIAN Arabic (بلهجة مصرية بسيطة ودودة) — like a knowledgeable Sedra sales engineer chatting on WhatsApp. For English, warm professional English. Never mix languages in one reply. No markdown headings, no bullet dumps — short friendly paragraphs.

WHO WE ARE:
Sedra Electric — a Cairo-based engineering house founded in 2014, specialised in light-current systems, smart automation and sustainable energy. Turnkey (from consultation to lifetime support). We serve homes, offices, hospitality, industrial and healthcare projects across Egypt, the UAE (Dubai) and Saudi Arabia (Riyadh).

WHAT WE DO (be ready to explain any of these in detail, with real benefits):
1) Smart Home & KNX automation — smart lighting, climate/AC control, automatic curtains/blinds, scenes (e.g. "Movie", "Goodbye", "Morning"), multi-room audio, and control of everything from one app anywhere in the world; integrates with voice assistants.
2) Security & surveillance — CCTV cameras, access control, fire alarm, intrusion detection, live monitoring and phone alerts.
3) Networks & low-current (ELV) — structured cabling, Wi-Fi coverage, data/networking, intercom, and complete low-current infrastructure.
4) Solar energy — rooftop solar systems with net-metering to cut the electricity bill; typical payback is roughly 5–7 years (give this as an estimate, not a promise).
5) EV charging — home and compound EV charging stations.
6) Home cinema and BMS for smart buildings.

HOW WE WORK (mention when relevant): free consultation → site survey & design → clear quotation → professional installation → testing & handover → training and after-sales support/maintenance. We're engineering-led, deliver on schedule, and stand behind our work after the sale.

COVERAGE: Egypt (Cairo, New Cairo, Sheikh Zayed, 6th of October, New Administrative Capital and more), UAE (Dubai), KSA (Riyadh).

PRICING: There is no fixed price — it depends on the space (m²), which systems, and the finishing level. Never invent numbers or quote a figure. Explain this simply and offer a FREE site visit / quotation.

YOUR GOAL: genuinely help AND collect the visitor's details. Answer their question well first, then naturally ask for their NAME, PHONE (WhatsApp), CITY, and which SERVICE they're interested in, and invite them to press the "Request a quote" button so the team calls them. If they want a human, are in a hurry, or you're unsure — give WhatsApp +201125441197 (or email Info@sedra-electric.com) and suggest the quote button.

RULES: Be accurate; if you don't know something, say you'll connect them with the Sedra team rather than guessing. Stay on Sedra-related topics; if asked something unrelated, answer briefly and steer back warmly. Always be encouraging and make the visitor feel taken care of.`;

/* Curated knowledge / FAQ — grounds the assistant so it answers accurately without inventing.
   Edit this freely (or override everything via the SYSTEM_PROMPT env var). */
const KNOWLEDGE = `
EXTRA KNOWLEDGE & FAQ (use naturally; never read it out like a list):
• KNX vs wireless: KNX is the global wired standard — the most reliable and future-proof for full villas/buildings; wireless (e.g. Zigbee/Wi-Fi based) suits ready/finished flats where wiring is hard. We advise the right mix per project after the site survey.
• Existing/finished home? Yes — we have wireless and retrofit solutions that don't need to break walls. Best answered after a quick visit.
• One app for everything: lighting, AC, curtains, cameras, doors, energy — from your phone, local or from abroad. Works with Alexa / Google Assistant.
• Scenes: one touch runs many devices together (e.g. "Goodbye" turns off lights/AC and arms security; "Movie" dims lights and closes curtains).
• Security: CCTV with phone alerts and live view, smart door locks, access control, fire and intrusion alarms, video door phone.
• Solar: cuts the electricity bill via net-metering; rough payback ~5–7 years (estimate only, depends on consumption and system size). We handle design, permits, install and maintenance.
• EV charging: home and compound chargers, safe dedicated circuits.
• After-sales: training on handover + maintenance and support contracts. We stand behind the work after the sale.
• Timeline: depends on project size and scope; given after the survey. Never promise an exact number without a survey.
• Warranty: equipment carries manufacturer warranty; we provide workmanship support — details confirmed in the quotation.
• Do NOT invent prices, specific brand names, discount percentages, or delivery dates. If asked, explain it depends on the project and offer a free site visit or WhatsApp +201125441197.
• Working hours: Sunday–Thursday roughly 10:00–18:00 Cairo time (Friday/Saturday lighter). If a visitor writes outside hours, reassure them the team will reply the next working period and offer WhatsApp for anything urgent.
`;

const MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/qwen/qwen2.5-7b-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/meta/llama-3.1-8b-instruct'
];

function cors(){return{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'};}
function json(o,s=200){return new Response(JSON.stringify(o),{status:s,headers:{'Content-Type':'application/json; charset=utf-8',...cors()}});}

/* Live date/time in Cairo — injected each request so the assistant always knows "today"
   (the AI model has a fixed training cutoff and no real clock of its own). */
function nowCairo(){
  try{
    const f = new Intl.DateTimeFormat('en-GB', { timeZone:'Africa/Cairo', weekday:'long',
      year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false });
    return f.format(new Date());
  }catch(e){ return new Date().toISOString(); }
}
function datePreamble(){
  return `REAL CURRENT DATE & TIME (Africa/Cairo): ${nowCairo()}.
This is the real "today" — always treat it as the present moment. We are in this exact month and year right now; never assume, state, or imply any earlier date (your training data is older than today — ignore it for anything time-related). Always speak in the PRESENT tense about Sedra: we ARE open and operating today. If the visitor asks about the date, day, current time, "this month", latest offers, delivery timing, or anything time-sensitive, base it on the date above. Greet by time of day when natural (صباح الخير / مساء الخير).`;
}

/* Friendly fallback shown when every AI model fails, so the visitor is never left hanging. */
function fallbackReply(lang){
  return (lang==='ar')
    ? "معلش حصل ضغط بسيط على المساعد دلوقتي 🙏 بس فريق سيدرا جاهز يساعدك على طول — كلّمنا واتساب على +201125441197 أو اضغط \"اطلب عرض سعر\" ونتواصل معاك."
    : "Sorry — the assistant is a little busy right now 🙏 But the Sedra team is ready to help you directly. WhatsApp us at +201125441197 or tap \"Request a quote\" and we'll reach out.";
}

/* Optional Cloudflare Turnstile verification (only enforced if TURNSTILE_SECRET is set). */
async function turnstileOK(env, token, ip){
  if(!env.TURNSTILE_SECRET) return true;            // not configured → skip
  if(!token) return false;
  try{
    const body = new URLSearchParams();
    body.append('secret', env.TURNSTILE_SECRET);
    body.append('response', token);
    if(ip) body.append('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method:'POST', body });
    const j = await r.json().catch(()=>({success:false}));
    return !!j.success;
  }catch(e){ return true; }                          // never block on our own error
}

/* Optional simple per-IP rate limit (only if a KV namespace named RATE_KV is bound). */
async function rateLimited(env, ip){
  if(!env.RATE_KV || !ip) return false;
  try{
    const key = 'r:'+ip+':'+Math.floor(Date.now()/60000);   // per-minute bucket
    const cur = parseInt(await env.RATE_KV.get(key) || '0', 10);
    if(cur >= 20) return true;                               // max 20 messages/min/IP
    await env.RATE_KV.put(key, String(cur+1), { expirationTtl: 120 });
    return false;
  }catch(e){ return false; }
}

/* Fire-and-forget: save the running transcript to Firebase so you can see what people ask. */
function logChat(env, sid, messages, lang, ctx){
  try{
    const DB = env.LEAD_DB_URL || "https://sedra-crm-default-rtdb.firebaseio.com";
    const node = env.CHATS_NODE || "chats";
    const id = (sid && String(sid).replace(/[^\w-]/g,'').slice(0,40)) || ('s'+Date.now());
    const rec = {
      sid: id, lang: String(lang||'').slice(0,4), turns: messages.length,
      messages: messages.slice(-20),
      updated: new Date().toISOString(), ts: Date.now()
    };
    const p = fetch(`${DB}/${node}/${id}.json`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(rec) });
    if(ctx && ctx.waitUntil) ctx.waitUntil(p); else p.catch(()=>{});
  }catch(e){}
}

export function onRequestOptions(){return new Response(null,{headers:cors()});}

export async function onRequestPost(context){
  const { request, env } = context;
  const ip = request.headers.get('CF-Connecting-IP') || '';
  try{
    if(!env.AI){ return json({reply:"", error:"AI binding missing"}, 500); }
    const body = await request.json().catch(()=>({}));
    const lang = (body.lang==='ar') ? 'ar' : (body.lang || '');

    // ---- basic anti-abuse ----
    if(await rateLimited(env, ip)){
      return json({ reply: fallbackReply(lang||'en') });
    }
    if(!(await turnstileOK(env, body.ts_token, ip))){
      return json({ reply: fallbackReply(lang||'en') });
    }

    let history = Array.isArray(body.messages) ? body.messages
        .filter(m=>m && (m.role==='user'||m.role==='assistant') && typeof m.content==='string')
        .map(m=>({role:m.role, content:String(m.content).slice(0,2000)}))   // cap message size
        .slice(-14) : [];
    if(history.length > 40) history = history.slice(-40);

    const base = (env.SYSTEM_PROMPT && env.SYSTEM_PROMPT.trim()) ? env.SYSTEM_PROMPT : SYSTEM_DEFAULT;
    const system = datePreamble() + "\n\n" + base + "\n" + KNOWLEDGE;
    const messages = [{role:'system', content: system}, ...history];
    const list = (env.MODEL ? [env.MODEL] : []).concat(MODELS);

    // save transcript (fire-and-forget)
    logChat(env, body.sid, history, lang, context);

    const wantStream = body.stream === true;

    // ---------- streaming path ----------
    if(wantStream){
      for(const model of list){
        try{
          const stream = await env.AI.run(model, { messages, max_tokens: 640, temperature: 0.6, stream: true });
          return new Response(stream, { headers: { 'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-cache', ...cors() } });
        }catch(e){ /* try next model */ }
      }
      // all failed → send fallback as a single SSE chunk the widget can read
      const enc = new TextEncoder();
      const rs = new ReadableStream({ start(c){
        c.enqueue(enc.encode('data: '+JSON.stringify({response: fallbackReply(lang||'en')})+'\n\n'));
        c.enqueue(enc.encode('data: [DONE]\n\n')); c.close();
      }});
      return new Response(rs, { headers:{ 'Content-Type':'text/event-stream; charset=utf-8', ...cors() } });
    }

    // ---------- non-streaming path ----------
    let lastErr="";
    for(const model of list){
      try{
        const r = await env.AI.run(model, { messages, max_tokens: 640, temperature: 0.6 });
        const reply = r && (r.response || (r.result && r.result.response));
        if(reply){ return json({ reply: String(reply).trim() }); }
      }catch(e){ lastErr = String(e && e.message || e); }
    }
    return json({ reply: fallbackReply(lang||'en'), error: lastErr || "no model responded" });
  }catch(e){
    return json({ reply: fallbackReply(''), error: String(e && e.message || e) });
  }
}
