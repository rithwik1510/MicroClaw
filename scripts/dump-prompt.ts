import { buildContextBundle } from '../src/context/builder.js';
import { initDatabase, getRecentMessages } from '../src/db.js';
import { buildContinuityPlan, buildContinuityPrompt } from '../src/continuity.js';

initDatabase();

// 1. System prompt
const ctx = buildContextBundle({
  groupFolder: 'discord_dm',
  prompt: 'hey whats up',
  turnMode: 'conversational',
  reservedToolChars: 2500,
  actualToolSchemaChars: 0,
});
console.log(`\n${'='.repeat(60)}`);
console.log(`SYSTEM PROMPT (${ctx.systemPrompt.length} chars)`);
console.log('='.repeat(60));
console.log(ctx.systemPrompt);

// 2. User prompt (continuity + current message)
const recent = getRecentMessages('dc:1473668401544167446', 120);
const plan = buildContinuityPlan({
  assistantName: 'Andy',
  conversationMessages: recent,
  recentTurnLimit: 12,
});
const contPrompt = buildContinuityPrompt({
  assistantName: 'Andy',
  summary: plan.summaryToUse,
  recentContextMessages: plan.recentContextMessages,
  currentMessages: [{
    id: 'now',
    chat_jid: 'dc:1',
    sender: 'user',
    sender_name: 'Rishi',
    content: 'hey whats up',
    timestamp: new Date().toISOString(),
  }],
});

console.log(`\n${'='.repeat(60)}`);
console.log(`USER PROMPT (${contPrompt.length} chars)`);
console.log('='.repeat(60));
console.log(contPrompt);

console.log(`\n${'='.repeat(60)}`);
console.log('DIAGNOSTICS');
console.log('='.repeat(60));
console.log(`Recent messages: ${plan.recentContextMessages.length}`);
for (const [i, m] of plan.recentContextMessages.entries()) {
  const role = m.is_bot_message ? 'BOT' : 'USER';
  console.log(`  [${i}] ${role} (${m.content.length} chars): ${m.content.slice(0, 150).replace(/\n/g, '\\n')}`);
}
console.log(`Summary: ${plan.summaryToUse.length} chars`);
console.log(JSON.stringify(plan.diagnostics, null, 2));
