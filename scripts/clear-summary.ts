import { initDatabase, clearConversationSummary, getConversationSummary } from '../src/db.js';

initDatabase();

const before = getConversationSummary('discord_dm');
console.log('Before:', before ? `${before.summary.length} chars` : 'none');
if (before) {
  console.log('Summary preview:', before.summary.slice(0, 300));
}

clearConversationSummary('discord_dm');

const after = getConversationSummary('discord_dm');
console.log('\nAfter clear:', after ? 'still exists' : 'cleared successfully');
console.log('Next message will build a fresh summary from recent conversations only.');
