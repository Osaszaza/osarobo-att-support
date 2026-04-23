require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const OpenAI   = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// ═══════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════

const INTENT_META = {
  technical_support:   { label: 'Technical Support',   icon: '🔧', color: '#ff6b6b' },
  account_query:       { label: 'Account & Billing',   icon: '👤', color: '#00a8e0' },
  service_inquiry:     { label: 'Service Inquiry',     icon: '📦', color: '#fb923c' },
  information_request: { label: 'Information Request', icon: '💡', color: '#a78bfa' },
  system_curiosity:    { label: 'About Osarobo',       icon: '🤖', color: '#00d68f' },
  general_chat:        { label: 'General Chat',        icon: '💬', color: '#5a7090' }
};

const INTENT_SUGGESTIONS = {
  technical_support:   'Add step-by-step network and device troubleshooting guides with diagnostic question flows.',
  account_query:       'Improve password reset, login, and billing explanation flows with clearer step-by-step guidance.',
  service_inquiry:     'Provide explicit timelines for refunds, order tracking, and cancellation to reduce uncertainty.',
  information_request: 'Build a structured FAQ layer so common questions get instant, accurate answers.',
  system_curiosity:    'Improve Osarobo\'s self-introduction and capability explanation to build user trust faster.',
  general_chat:        'Strengthen topic routing to guide general conversations toward relevant support categories.'
};

const SYNONYM_MAP = {
  'pwd':'password','pswd':'password','passw':'password',
  'acct':'account','acc':'account',
  'creted':'created','cretaed':'created','craeted':'created',
  'recieve':'receive','recieved':'received',
  'cancelation':'cancellation','biling':'billing',
  'paymant':'payment','payement':'payment',
  'techincal':'technical','techical':'technical',
  'connexion':'connection','wifi':'wifi','wlan':'wifi'
};

const STOP_WORDS = new Set([
  'i','me','my','myself','we','our','the','a','an','is','it','in','on','at',
  'to','do','how','can','you','help','with','for','and','or','of','what',
  'please','need','want','have','get','would','could','should','this','that',
  'are','was','been','be','has','had','not','but','they','their','there',
  'when','about','your','from','just','also','will','all','its','im','am',
  'hi','hello','hey','yes','no','ok','okay','thank','thanks','very','much',
  'more','some','any','into','than','then','who','which','like','know',
  'make','time','use','new','good','back','see','does','did','still','even',
  'here','well','such','were','too','same','both','each','other','these',
  'those','them','where','why','being','after','before','while','through',
  'again','between','own','few','many','most','because','since','until',
  'using','used','come','came','coming','going','went','using'
]);

// ═══════════════════════════════════════════════════════════════
//  CLASSIFICATION & DETECTION
// ═══════════════════════════════════════════════════════════════

function classifyIntent(msg) {
  const t = msg.toLowerCase().trim();
  if (/who (are|made|created|built) you|what (are|can) you|how (were|are) you (made|created|trained)|your (name|purpose)|tell me about yourself|are you (a bot|an ai|real|human)/i.test(t))
    return 'system_curiosity';
  if (/\b(password|login|sign.?in|log.?in|account|billing|payment|charge|invoice|plan|subscription|upgrade|downgrade|profile|email|username|verify|authentication|2fa|credit card|bank)\b/i.test(t))
    return 'account_query';
  if (/\b(not working|broken|error|issue|problem|fix|crash|bug|fail|glitch|slow|down|outage|can'?t|cannot|won'?t|doesn'?t work|stopped|network|connection|signal|speed|internet|data)\b/i.test(t))
    return 'technical_support';
  if (/\b(track|order|refund|return|cancel|cancellation|status|shipping|deliver|complaint|dispute|chargeback|report|coverage)\b/i.test(t))
    return 'service_inquiry';
  if (/\b(what is|how do|how to|how does|tell me|explain|understand|guide|tutorial|show me|what happens|difference between)\b/i.test(t))
    return 'information_request';
  return 'general_chat';
}

function detectSentiment(msg) {
  const t = msg.toLowerCase();
  if (/\b(furious|outraged|unacceptable|ridiculous|terrible|awful|disgusting|worst|never again|lawsuit|scam|fraud|lied|incompetent|useless|pathetic|hate|horrible)\b/i.test(t))
    return 'angry';
  if (/\b(frustrated|annoyed|upset|disappointed|unhappy|fed up|sick of|tired of|keeps happening|again|still not|not working again|third time|multiple times)\b/i.test(t))
    return 'frustrated';
  if (/\b(happy|great|love|excellent|amazing|wonderful|appreciate|perfect|brilliant|fantastic|awesome|wonderful)\b/i.test(t))
    return 'happy';
  if (/\b(curious|wondering|just asking|quick question|wanted to know|what if|interested in|thinking about|considering)\b/i.test(t))
    return 'curious';
  return 'neutral';
}

function isEscalationRequest(msg) {
  return /\b(human|agent|person|representative|operator|speak to|talk to|transfer|escalate|supervisor|manager|real person|live agent|call center)\b/i.test(msg);
}

function estimateResolution(aiResponse) {
  return !/i'?m (unable|sorry|afraid)|i (can'?t|cannot|don'?t know|lack)|unfortunately|please (contact|call|visit|reach)|beyond my (ability|capability|scope)|i (don'?t have (access|information|details))/i
    .test(aiResponse);
}

function normalizeKeyword(w) { return SYNONYM_MAP[w.toLowerCase()] ?? w.toLowerCase(); }

function extractKeywords(text) {
  return text.toLowerCase().replace(/[^a-z\s]/g,' ').split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w));
}

// ═══════════════════════════════════════════════════════════════
//  ADAPTIVE SYSTEM PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════

function buildAdaptivePrompt(intent, sentiment, msgCountInSession) {
  const lines = [
    'You are Osarobo, the official AI Customer Support Assistant for AT&T.',
    'You are professional, empathetic, concise, and always solution-focused.'
  ];

  // Sentiment-driven tone rules
  const toneMap = {
    angry:
      'PRIORITY: This customer is angry. Open with a sincere, specific apology. ' +
      'Validate their frustration before offering any solution. Stay calm and patient. ' +
      'If the issue is complex, proactively offer to connect them with a human AT&T specialist.',
    frustrated:
      'This customer is frustrated. Lead with empathy and acknowledge the inconvenience clearly. ' +
      'Be direct and provide concise resolution steps. Avoid lengthy explanations.',
    happy:
      'The customer is in a positive mood. Match their energy professionally and be efficient.',
    curious:
      'The customer is exploring or curious. Be thorough, informative, and offer related helpful context.',
    neutral:
      'Maintain a professional, warm, and efficient tone throughout.'
  };
  lines.push(toneMap[sentiment] ?? toneMap.neutral);

  // Intent-driven response structure rules
  const intentMap = {
    technical_support:
      'For this technical issue: provide clear numbered troubleshooting steps. ' +
      'Ask one diagnostic question at a time. Be precise about what the customer should observe.',
    account_query:
      'For this account or billing matter: be precise about each step. ' +
      'Prioritize account security — never ask for full passwords or payment card numbers.',
    service_inquiry:
      'For this service inquiry: give clear timelines and expected outcomes. ' +
      'Set realistic expectations about what AT&T can and cannot do.',
    information_request:
      'Provide accurate, well-structured information. Use short bullet points for complex answers.',
    system_curiosity:
      'Introduce yourself: you are Osarobo, AT&T\'s AI support assistant. ' +
      'Be transparent about your capabilities. Mention you can help with billing, technical issues, and service questions.',
    general_chat:
      'Be friendly and guide the conversation toward support topics if relevant.'
  };
  if (intentMap[intent]) lines.push(intentMap[intent]);

  // Long-session escalation nudge
  if (msgCountInSession >= 6) {
    lines.push(
      'This customer has sent several messages. If their issue is not yet resolved, ' +
      'proactively offer: "Would you like me to connect you with an AT&T specialist for faster help?"'
    );
  }

  lines.push(
    'Keep responses under 130 words unless technical depth is required. ' +
    'Always end with a clear next step, question, or offer.'
  );

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
//  UTILITY
// ═══════════════════════════════════════════════════════════════

function periodRange(period) {
  const ms  = period === '24h' ? 86_400_000 : 7 * 86_400_000;
  const now = Date.now();
  return {
    since:    new Date(now - ms).toISOString(),
    prevFrom: new Date(now - ms * 2).toISOString(),
    prevTo:   new Date(now - ms).toISOString()
  };
}

function trendPct(cur, prev) {
  if (prev === 0) return cur > 0 ? 100 : null;
  return Math.round(((cur - prev) / prev) * 100);
}

// ═══════════════════════════════════════════════════════════════
//  POST /chat — adaptive AI with full analytics capture
// ═══════════════════════════════════════════════════════════════

app.post('/chat', async (req, res) => {
  const { message, history = [], session_id, msg_count = 0 } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const intent       = classifyIntent(message);
  const sentiment    = detectSentiment(message);
  const isEscalation = isEscalationRequest(message);
  const startTime    = Date.now();

  const systemPrompt = buildAdaptivePrompt(intent, sentiment, msg_count);

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.slice(-12),
        { role: 'user', content: message.trim() }
      ],
      max_tokens: 400,
      temperature: 0.7
    });

    const aiResponse     = completion.choices[0].message.content;
    const responseTimeMs = Date.now() - startTime;
    const isResolved     = estimateResolution(aiResponse);

    const { data: inserted, error: dbError } = await supabase
      .from('conversations')
      .insert({
        user_message:     message.trim(),
        ai_response:      aiResponse,
        session_id:       session_id ?? null,
        intent,
        sentiment,
        is_resolved:      isResolved,
        was_escalated:    isEscalation,
        response_time_ms: responseTimeMs
      })
      .select('id')
      .single();

    if (dbError) console.error('[Supabase] insert error:', dbError.message);

    return res.json({
      response:        aiResponse,
      conversation_id: inserted?.id ?? null,
      is_escalation:   isEscalation,
      intent,
      sentiment
    });

  } catch (err) {
    console.error('[/chat] error:', err);
    if (err.status === 401) return res.status(401).json({ error: 'Invalid OpenAI API key.' });
    if (err.status === 429) return res.status(429).json({ error: 'Rate limit reached. Please try again shortly.' });
    return res.status(500).json({ error: err.message || 'Internal server error.' });
  }
});

// ═══════════════════════════════════════════════════════════════
//  POST /feedback — real resolution tracking
// ═══════════════════════════════════════════════════════════════

app.post('/feedback', async (req, res) => {
  const { session_id, conversation_id, was_helpful } = req.body;

  if (!session_id || typeof was_helpful !== 'boolean') {
    return res.status(400).json({ error: 'session_id and was_helpful (boolean) are required.' });
  }

  try {
    const { error } = await supabase.from('conversation_feedback').insert({
      session_id,
      conversation_id: conversation_id ?? null,
      was_helpful
    });

    if (error) {
      console.error('[feedback] insert error:', error.message);
      return res.status(500).json({ error: 'Could not save feedback.' });
    }

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  POST /summarize
// ═══════════════════════════════════════════════════════════════

app.post('/summarize', async (req, res) => {
  const { transcript } = req.body;
  if (!transcript || typeof transcript !== 'string') {
    return res.status(400).json({ error: 'transcript is required' });
  }
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Summarize this AT&T customer support conversation in 2-3 concise sentences. State the main issue and resolution status.' },
        { role: 'user', content: transcript }
      ],
      max_tokens: 180
    });
    const summaryText = completion.choices[0].message.content;
    await supabase.from('summaries').insert({ summary_text: summaryText });
    return res.json({ summary: summaryText });
  } catch (err) {
    console.error('[/summarize] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  GET /stats?period=24h|7d — KPI metrics with trends
// ═══════════════════════════════════════════════════════════════

app.get('/stats', async (req, res) => {
  const period = req.query.period === '24h' ? '24h' : '7d';
  const { since, prevFrom, prevTo } = periodRange(period);

  try {
    const [
      totalConvs, periodConvs, prevConvs,
      totalSummaries, lastConv,
      escalatedTotal, rtRows,
      allConvData, feedbackData
    ] = await Promise.all([
      supabase.from('conversations').select('*', { count: 'exact', head: true }),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).gte('created_at', since),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).gte('created_at', prevFrom).lt('created_at', prevTo),
      supabase.from('summaries').select('*', { count: 'exact', head: true }),
      supabase.from('conversations').select('created_at').order('created_at', { ascending: false }).limit(1),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('was_escalated', true).gte('created_at', since),
      supabase.from('conversations').select('response_time_ms').not('response_time_ms', 'is', null).gte('created_at', since),
      supabase.from('conversations').select('ai_response, is_resolved').limit(300),
      supabase.from('conversation_feedback').select('was_helpful').limit(500)
    ]);

    const total   = totalConvs.count  ?? 0;
    const current = periodConvs.count ?? 0;
    const prev    = prevConvs.count   ?? 0;

    // Avg response time
    const rtVals = (rtRows.data ?? []).map(r => r.response_time_ms).filter(Boolean);
    const avgRt  = rtVals.length > 0
      ? Math.round(rtVals.reduce((a, b) => a + b, 0) / rtVals.length)
      : null;

    // Resolution rate: prefer real feedback, fall back to heuristic
    const fb = feedbackData.data ?? [];
    let resolutionRate;
    if (fb.length >= 3) {
      resolutionRate = Math.round((fb.filter(f => f.was_helpful).length / fb.length) * 100);
    } else {
      const convs = allConvData.data ?? [];
      let resolved = 0;
      convs.forEach(c => {
        const r = c.is_resolved !== null ? c.is_resolved : estimateResolution(c.ai_response ?? '');
        if (r) resolved++;
      });
      resolutionRate = convs.length > 0 ? Math.round((resolved / convs.length) * 100) : null;
    }

    // Escalation rate for the period
    const escalationRate = current > 0
      ? Math.round(((escalatedTotal.count ?? 0) / current) * 100)
      : 0;

    return res.json({
      period,
      total_conversations:  total,
      period_conversations: current,
      prev_conversations:   prev,
      trend_pct:            trendPct(current, prev),
      total_messages:       total * 2,
      period_messages:      current * 2,
      total_summaries:      totalSummaries.count ?? 0,
      last_activity:        lastConv.data?.[0]?.created_at ?? null,
      avg_response_time_ms: avgRt,
      resolution_rate:      resolutionRate,
      escalation_rate:      escalationRate,
      feedback_count:       fb.length
    });

  } catch (err) {
    console.error('[/stats] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  GET /insights?period=24h|7d — intent, topics, summaries
// ═══════════════════════════════════════════════════════════════

app.get('/insights', async (req, res) => {
  try {
    const [summariesResult, convsResult] = await Promise.all([
      supabase.from('summaries').select('*').order('created_at', { ascending: false }).limit(8),
      supabase.from('conversations')
        .select('user_message, ai_response, created_at, intent, sentiment')
        .order('created_at', { ascending: false })
        .limit(200)
    ]);

    const summaries     = summariesResult.data ?? [];
    const conversations = convsResult.data ?? [];

    // Intent breakdown with sentiment overlay
    const intentMap = {};
    conversations.forEach(c => {
      const intent = c.intent ?? classifyIntent(c.user_message);
      if (!intentMap[intent]) intentMap[intent] = { count: 0, sentiments: {} };
      intentMap[intent].count++;
      const s = c.sentiment ?? 'neutral';
      intentMap[intent].sentiments[s] = (intentMap[intent].sentiments[s] ?? 0) + 1;
    });

    const total = conversations.length;
    const intent_breakdown = Object.entries(intentMap)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([intent, data]) => ({
        intent,
        count: data.count,
        pct:   total > 0 ? Math.round((data.count / total) * 100) : 0,
        dominant_sentiment: Object.entries(data.sentiments).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'neutral',
        ...(INTENT_META[intent] ?? { label: intent, icon: '💬', color: '#5a7090' })
      }));

    // Semantic keyword extraction
    const kwMap = {};
    conversations.forEach(({ user_message }) => {
      extractKeywords(user_message).forEach(raw => {
        const w = normalizeKeyword(raw);
        if (w.length > 3) kwMap[w] = (kwMap[w] ?? 0) + 1;
      });
    });

    const common_topics = Object.entries(kwMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word, count]) => ({ word, count }));

    // Fallback summary if none exist
    let finalSummaries = summaries;
    if (!summaries.length && conversations.length > 0) {
      try {
        const transcript = conversations.slice(0, 5).reverse()
          .map(c => `Customer: ${c.user_message}\nOsarobo: ${c.ai_response}`).join('\n\n');

        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Summarize these AT&T customer support conversations in 2-3 sentences covering main topics and resolution status.' },
            { role: 'user', content: transcript }
          ],
          max_tokens: 180
        });

        const summaryText = completion.choices[0].message.content;
        const { data: ins } = await supabase.from('summaries').insert({ summary_text: summaryText }).select().single();
        finalSummaries = [ins ?? { summary_text: summaryText, created_at: new Date().toISOString() }];
        console.log('[insights] Fallback summary generated.');
      } catch (e) {
        console.error('[insights] Fallback summary failed:', e.message);
      }
    }

    return res.json({
      intent_breakdown,
      common_topics,
      summaries: finalSummaries,
      recent_conversations: conversations.slice(0, 8)
    });

  } catch (err) {
    console.error('[/insights] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  GET /health-insights — system health, KPIs, AI improvement loop
// ═══════════════════════════════════════════════════════════════

app.get('/health-insights', async (req, res) => {
  try {
    const [convsResult, feedbackResult] = await Promise.all([
      supabase.from('conversations')
        .select('id, intent, is_resolved, was_escalated, session_id, created_at, ai_response, sentiment')
        .order('created_at', { ascending: false })
        .limit(500),
      supabase.from('conversation_feedback')
        .select('was_helpful, session_id, conversation_id')
        .limit(500)
    ]);

    const convs    = convsResult.data    ?? [];
    const feedback = feedbackResult.data ?? [];

    // ── Escalation rate ────────────────────────────────────────
    const escalatedCount = convs.filter(c => c.was_escalated).length;
    const escalationRate = convs.length > 0
      ? Math.round((escalatedCount / convs.length) * 100) : 0;

    // ── Resolution rate (prefer feedback) ─────────────────────
    let resolutionRate;
    if (feedback.length >= 3) {
      resolutionRate = Math.round((feedback.filter(f => f.was_helpful).length / feedback.length) * 100);
    } else {
      let resolved = 0;
      convs.forEach(c => {
        if (c.is_resolved !== null ? c.is_resolved : estimateResolution(c.ai_response ?? '')) resolved++;
      });
      resolutionRate = convs.length > 0 ? Math.round((resolved / convs.length) * 100) : 0;
    }
    const unresolvedRate = 100 - resolutionRate;

    // ── Per-intent resolution breakdown ───────────────────────
    const intentStats = {};
    convs.forEach(c => {
      const intent = c.intent ?? 'general_chat';
      if (!intentStats[intent]) intentStats[intent] = { total: 0, resolved: 0, escalated: 0 };
      intentStats[intent].total++;
      if (c.is_resolved !== null ? c.is_resolved : estimateResolution(c.ai_response ?? ''))
        intentStats[intent].resolved++;
      if (c.was_escalated) intentStats[intent].escalated++;
    });

    const intentBreakdown = Object.entries(intentStats).map(([intent, s]) => ({
      intent,
      label:            INTENT_META[intent]?.label   ?? intent,
      icon:             INTENT_META[intent]?.icon    ?? '💬',
      color:            INTENT_META[intent]?.color   ?? '#5a7090',
      count:            s.total,
      resolution_rate:  Math.round((s.resolved  / s.total) * 100),
      escalation_rate:  Math.round((s.escalated / s.total) * 100)
    })).sort((a, b) => a.resolution_rate - b.resolution_rate);

    const topFailingIntents = intentBreakdown.filter(i => i.resolution_rate < 80).slice(0, 5);

    // ── Drop-off rate (sessions with only 1 message) ──────────
    const sessionCounts = {};
    convs.forEach(c => {
      if (c.session_id) sessionCounts[c.session_id] = (sessionCounts[c.session_id] ?? 0) + 1;
    });
    const totalSessions  = Object.keys(sessionCounts).length;
    const dropOffSessions = Object.values(sessionCounts).filter(n => n === 1).length;
    const dropOffRate    = totalSessions > 0 ? Math.round((dropOffSessions / totalSessions) * 100) : 0;

    // ── Repeat issue rate (same intent across different sessions) ──
    const sessionIntentMap = {};
    convs.forEach(c => {
      if (c.session_id && c.intent) {
        if (!sessionIntentMap[c.session_id]) sessionIntentMap[c.session_id] = new Set();
        sessionIntentMap[c.session_id].add(c.intent);
      }
    });
    const intentSessionFreq = {};
    Object.values(sessionIntentMap).forEach(intents => {
      intents.forEach(i => { intentSessionFreq[i] = (intentSessionFreq[i] ?? 0) + 1; });
    });
    const repeatedIntentSessions = Object.values(intentSessionFreq).filter(n => n > 1).length;
    const repeatIssueRate = totalSessions > 1
      ? Math.round((repeatedIntentSessions / totalSessions) * 100) : 0;

    // ── Avg time to resolution (per session) ─────────────────
    const sessionTimeMap = {};
    convs.forEach(c => {
      if (!c.session_id) return;
      const t = new Date(c.created_at).getTime();
      if (!sessionTimeMap[c.session_id])
        sessionTimeMap[c.session_id] = { min: t, max: t };
      else {
        if (t < sessionTimeMap[c.session_id].min) sessionTimeMap[c.session_id].min = t;
        if (t > sessionTimeMap[c.session_id].max) sessionTimeMap[c.session_id].max = t;
      }
    });
    const durations = Object.values(sessionTimeMap)
      .map(t => (t.max - t.min) / 60000).filter(d => d > 0);
    const avgTimeToResolution = durations.length > 0
      ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
      : null;

    // ── Sentiment distribution ─────────────────────────────────
    const sentimentCounts = {};
    convs.forEach(c => {
      const s = c.sentiment ?? 'neutral';
      sentimentCounts[s] = (sentimentCounts[s] ?? 0) + 1;
    });

    // ── AI improvement suggestions ─────────────────────────────
    const improvement_suggestions = topFailingIntents.map(i => ({
      intent:          i.intent,
      label:           i.label,
      icon:            i.icon,
      resolution_rate: i.resolution_rate,
      suggestion:      INTENT_SUGGESTIONS[i.intent] ?? 'Review and improve automated responses for this category.'
    }));

    // ── System warnings ────────────────────────────────────────
    const warnings = [];
    if (unresolvedRate > 35)
      warnings.push({ level: 'critical', message: `Critical: ${unresolvedRate}% unresolved rate. Immediate review of AI response quality required.` });
    else if (unresolvedRate > 20)
      warnings.push({ level: 'warning', message: `Elevated unresolved rate (${unresolvedRate}%). Consider reviewing top failing intents.` });

    if (escalationRate > 25)
      warnings.push({ level: 'critical', message: `Escalation rate (${escalationRate}%) is very high. Review automated responses for complex topics.` });
    else if (escalationRate > 10)
      warnings.push({ level: 'warning', message: `Escalation rate (${escalationRate}%) is above the 10% target. Check top escalation triggers.` });

    if (dropOffRate > 60)
      warnings.push({ level: 'warning', message: `High drop-off rate (${dropOffRate}%). First responses may not be resolving user queries effectively.` });

    if (repeatIssueRate > 30)
      warnings.push({ level: 'warning', message: `Repeat issue rate (${repeatIssueRate}%) is high. Certain issues are recurring across sessions.` });

    if (topFailingIntents.length > 0)
      warnings.push({ level: 'info', message: `${topFailingIntents.length} intent category(s) below 80% resolution. See improvement suggestions.` });

    if (!warnings.length)
      warnings.push({ level: 'ok', message: 'All systems performing within expected parameters. No critical issues detected.' });

    return res.json({
      unresolved_rate:           unresolvedRate,
      resolution_rate:           resolutionRate,
      escalation_rate:           escalationRate,
      drop_off_rate:             dropOffRate,
      repeat_issue_rate:         repeatIssueRate,
      avg_time_to_resolution:    avgTimeToResolution,
      feedback_count:            feedback.length,
      total_sessions:            totalSessions,
      sentiment_distribution:    sentimentCounts,
      top_failing_intents:       topFailingIntents,
      intent_breakdown:          intentBreakdown,
      improvement_suggestions,
      warnings
    });

  } catch (err) {
    console.error('[/health-insights] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  Health
// ═══════════════════════════════════════════════════════════════

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ═══════════════════════════════════════════════════════════════
//  Start
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Osarobo - AT&T App  →  http://localhost:${PORT}`);
  console.log(`  Endpoints: /chat  /feedback  /summarize  /stats  /insights  /health-insights  /health`);
  console.log(`  OpenAI  : ${process.env.OPENAI_API_KEY ? 'configured' : 'MISSING'}`);
  console.log(`  Supabase: ${process.env.SUPABASE_URL   ? 'configured' : 'MISSING'}\n`);
});
