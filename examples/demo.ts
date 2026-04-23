/**
 * Demo: exercise the full memory stack.
 *
 *   docker compose up -d
 *   npx tsx examples/demo.ts
 */

import { MemoryManager } from '../src/stores/MemoryManager.js';
import { Consolidator } from '../src/consolidation/Consolidator.js';

async function main() {
  console.log('🧠 Connecting to NeuroMem stack...\n');
  const mgr = await MemoryManager.create();
  const consolidator = new Consolidator(mgr);

  const agent_id = 'demo-agent';

  // ─── Write some memories ─────────────────────────────────────
  console.log('📝 Writing memories...\n');
  const samples = [
    'The user prefers dark mode and concise responses. #preferences',
    'Today we debugged a tricky async race condition. Finally solved it! #debugging #async',
    'How to deploy staging: 1. npm build 2. Push to staging 3. Verify health check. #deployment',
    'User mentioned they are allergic to peanuts. Critical! #health #critical',
    'Great conversation about neuroscience and memory today. #learning',
    'Yesterday worked through Python decorators with examples. #python #tutoring',
  ];

  const written = [];
  for (const content of samples) {
    const mem = await mgr.remember({ content, agent_id });
    written.push(mem);
    console.log(`  ✓ [${mem.type.padEnd(10)}] ${mem.title.slice(0, 60)}`);
    console.log(`      ${mem.routing}\n`);
  }

  // ─── Associate two memories ───────────────────────────────────
  console.log('🔗 Linking related memories in the graph...\n');
  if (written.length >= 2) {
    await mgr.associate(written[0].id, written[4].id);
    console.log(`  ✓ linked ${written[0].id} ↔ ${written[4].id}\n`);
  }

  // ─── Recall ──────────────────────────────────────────────────
  console.log('🔍 Recalling "debugging async"...\n');
  const result = await mgr.recall({
    query: 'debugging async',
    agent_id,
    limit: 3,
  });
  for (const m of result.memories) {
    console.log(`  • [${m.type}] (imp:${m.importance.toFixed(2)}) ${m.title}`);
  }
  console.log(`\n  Strategy: ${result.strategy}, scanned: ${result.scanned}\n`);

  // ─── Spreading activation ────────────────────────────────────
  if (written[0]) {
    console.log(`🌊 Spreading activation from ${written[0].id}...\n`);
    const related = await mgr.spreadingActivation(written[0].id, 2, 5);
    for (const m of related) {
      console.log(`  • ${m.title}`);
    }
    console.log('');
  }

  // ─── Reflect ─────────────────────────────────────────────────
  console.log('💭 Reflecting on memory state...\n');
  const state = await mgr.reflect(agent_id, 7);
  console.log(JSON.stringify(state, null, 2));
  console.log('');

  // ─── Consolidate ─────────────────────────────────────────────
  console.log('💤 Running consolidation pass...\n');
  const report = await consolidator.run(agent_id);
  console.log(`  Processed:    ${report.processed}`);
  console.log(`  Consolidated: ${report.consolidated}`);
  console.log(`  Forgotten:    ${report.forgotten}`);
  console.log(`  New semantic: ${report.new_semantic}`);
  console.log(`  Duration:     ${report.duration_ms}ms\n`);

  await mgr.close();
  console.log('✅ Demo complete.\n');
}

main().catch((err) => {
  console.error('❌ Demo failed:', err);
  process.exit(1);
});
