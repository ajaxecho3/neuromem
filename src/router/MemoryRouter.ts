/**
 * MemoryRouter — Entorhinal Cortex classifier
 *
 * Heuristically decides which memory subsystem should handle new
 * content. Agents can override by passing an explicit `type`.
 */

import type { MemoryType, EmotionalValence } from "../types/index.js";
import type { InnerThought } from "../cognition/InnerThought.js";

export interface RoutingDecision {
  type: MemoryType;
  importance: number;
  valence: EmotionalValence;
  arousal: number;
  tags: string[];
  reasoning: string;
}

const PROCEDURAL_PATTERNS = [
  /\bhow to\b/i,
  /\bstep[- ]by[- ]step\b/i,
  /^\s*\d+\.\s/m,
  /\bfirst,?\s+.+then\b/i,
  /\b(install|configure|deploy|build|run|execute|setup|set up)\b/i,
  /\bto (enable|disable|start|stop|create|delete|update|fix)\b/i,
  /\b(command|script|workflow|process|procedure|instructions?)\b/i,
];

const EPISODIC_PATTERNS = [
  /\b(yesterday|today|tonight|last week|this morning|earlier|just now|recently)\b/i,
  /\bi (saw|did|went|met|heard|talked|spoke|felt|tried|learned|noticed|realized)\b/i,
  /\bwe (discussed|decided|agreed|met|worked|found|discovered|encountered)\b/i,
  /\b(happened|occurred|turned out|ended up|found out)\b/i,
  /\b(session|conversation|meeting|call|review)\b/i,
];

const SEMANTIC_PATTERNS = [
  /\bis (a|an|the)\b/i,
  /\b(definition|means|refers to|is defined as|stands for|known as)\b/i,
  /\bfact:/i,
  /\b(always|never|generally|typically|usually|by default|in general)\b/i,
  /\b(concept|principle|theory|rule|law|property|characteristic|feature)\b/i,
  /\b(represents?|describes?|indicates?|specifies?)\b/i,
];

const AFFECTIVE_PATTERNS = [
  /\b(feel|feeling|felt|emotion|mood)\b/i,
  /\b(anxious|excited|sad|happy|angry|love|hate|miss|fear|proud|ashamed|grateful)\b/i,
  /\b(emotional|personally|deeply|touched|moved|overwhelmed|relieved)\b/i,
  /\b(stressful|frustrating|rewarding|satisfying|disappointing)\b/i,
];

const WORKING_PATTERNS = [
  /\b(current task|right now|working on|in progress|todo|to-do|note to self)\b/i,
  /\b(temporarily|for now|short[- ]term|this session|remind me)\b/i,
  /\b(wip|draft|pending|blocked|next step)\b/i,
];

const POSITIVE = [
  "happy",
  "glad",
  "success",
  "achieved",
  "solved",
  "love",
  "thank",
  "appreciate",
  "great",
  "excellent",
  "perfect",
  "wonderful",
  "amazing",
];
const NEGATIVE = [
  "failed",
  "error",
  "bug",
  "broken",
  "frustrated",
  "angry",
  "problem",
  "crashed",
  "issue",
  "wrong",
  "incorrect",
  "terrible",
  "awful",
];
const HIGH_AROUSAL = [
  "critical",
  "urgent",
  "emergency",
  "deadline",
  "immediately",
  "must",
  "never",
  "important",
  "asap",
  "priority",
  "blocker",
];

// Keywords extracted as tags when no explicit hashtag is found
const DOMAIN_KEYWORDS = [
  "api",
  "database",
  "server",
  "deploy",
  "auth",
  "token",
  "config",
  "error",
  "bug",
  "feature",
  "test",
  "build",
  "memory",
  "agent",
  "model",
  "prompt",
  "docker",
  "postgres",
  "redis",
  "neo4j",
  "chroma",
  "mcp",
  "llm",
  "embedding",
];

// Common English words that are NOT useful tags
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "had",
  "her",
  "was",
  "one",
  "our",
  "out",
  "day",
  "get",
  "has",
  "him",
  "his",
  "how",
  "its",
  "may",
  "new",
  "now",
  "old",
  "see",
  "two",
  "way",
  "who",
  "did",
  "let",
  "put",
  "say",
  "she",
  "too",
  "use",
  "that",
  "this",
  "with",
  "from",
  "they",
  "will",
  "been",
  "have",
  "were",
  "said",
  "each",
  "which",
]);

export class MemoryRouter {
  constructor(private innerThought?: InnerThought) {}

  route(content: string, hints?: Partial<RoutingDecision>): RoutingDecision {
    const type = hints?.type ?? this.classify(content);
    const { valence, arousal } = this.emotion(content);
    const importance = hints?.importance ?? this.importance(content, arousal);
    const tags = hints?.tags ?? this.extractTags(content);

    return {
      type,
      importance,
      valence: hints?.valence ?? valence,
      arousal: hints?.arousal ?? arousal,
      tags,
      reasoning: this.explain(type),
    };
  }

  private classify(content: string): MemoryType {
    // Score-based: accumulate pattern hits per type, winner takes all.
    // This avoids the first-match problem where order determined the result.
    const candidates: [MemoryType, RegExp[]][] = [
      ["procedural", PROCEDURAL_PATTERNS],
      ["semantic", SEMANTIC_PATTERNS],
      ["episodic", EPISODIC_PATTERNS],
      ["affective", AFFECTIVE_PATTERNS],
      ["working", WORKING_PATTERNS],
    ];

    let bestType: MemoryType = "episodic"; // fallback
    let bestScore = 0;

    for (const [type, patterns] of candidates) {
      const score = this.scorePatterns(content, patterns);
      if (score > bestScore) {
        bestScore = score;
        bestType = type;
      }
    }

    return bestType;
  }

  private scorePatterns(content: string, patterns: RegExp[]): number {
    return patterns.reduce((sum, p) => sum + (p.test(content) ? 1 : 0), 0);
  }

  /** Returns the highest pattern-match score across all type categories. */
  private bestScore(content: string): number {
    const allPatterns = [
      PROCEDURAL_PATTERNS,
      SEMANTIC_PATTERNS,
      EPISODIC_PATTERNS,
      AFFECTIVE_PATTERNS,
      WORKING_PATTERNS,
    ];
    return Math.max(...allPatterns.map((p) => this.scorePatterns(content, p)));
  }

  private emotion(content: string) {
    const lower = content.toLowerCase();
    const pos = POSITIVE.filter((w) => lower.includes(w)).length;
    const neg = NEGATIVE.filter((w) => lower.includes(w)).length;
    const arousalHits = HIGH_AROUSAL.filter((w) => lower.includes(w)).length;
    const valence: EmotionalValence =
      pos > neg ? "positive" : neg > pos ? "negative" : "neutral";
    const arousal = Math.min(1, (arousalHits + Math.abs(pos - neg)) * 0.2);
    return { valence, arousal };
  }

  private importance(content: string, arousal: number): number {
    const lower = content.toLowerCase();
    const wordCount = lower.split(/\s+/).filter(Boolean).length;

    // Definitive statements signal high-value facts
    const DEFINITIVE = [
      "always",
      "never",
      "must",
      "is a",
      "means",
      "defined as",
      "important",
      "critical",
      "remember",
      "key",
      "essential",
    ];
    const definitiveHits = DEFINITIVE.filter((w) => lower.includes(w)).length;
    const definitiveFactor = Math.min(0.3, definitiveHits * 0.07);

    // Questions = uncertain info = slightly less important
    const questionPenalty = Math.min(
      0.15,
      (content.match(/\?/g)?.length ?? 0) * 0.05,
    );

    // Length: normalize to ~100 words as "full" content
    const lengthFactor = Math.min(1, wordCount / 100) * 0.2;

    return Math.min(
      1,
      Math.max(
        0,
        0.3 + arousal * 0.3 + lengthFactor + definitiveFactor - questionPenalty,
      ),
    );
  }

  private extractTags(content: string): string[] {
    const tags = new Set<string>();

    // 1. Explicit hashtags
    for (const m of content.matchAll(/#(\w+)/g)) {
      tags.add(m[1].toLowerCase());
    }

    // 2. Domain-specific keywords present in the text
    for (const kw of DOMAIN_KEYWORDS) {
      if (new RegExp(`\\b${kw}\\b`, "i").test(content)) tags.add(kw);
    }

    // 3. Capitalized proper nouns (mid-sentence, not after punctuation)
    for (const m of content.matchAll(/(?<![.!?\n]\s)\b([A-Z][a-z]{2,})\b/g)) {
      const word = m[1].toLowerCase();
      if (!STOP_WORDS.has(word)) tags.add(word);
    }

    return [...tags].slice(0, 10);
  }

  private anyMatch(content: string, patterns: RegExp[]): boolean {
    return patterns.some((p) => p.test(content));
  }

  private explain(type: MemoryType): string {
    const reasons: Record<MemoryType, string> = {
      procedural: "How-to / step-by-step → Cerebellum (procedural)",
      episodic: "Temporal/experiential markers → Hippocampus (episodic)",
      semantic: "Factual/definitional pattern → Temporal Cortex (semantic)",
      affective: "High emotional content → Amygdala (affective)",
      working: "Short-lived context → Prefrontal Cortex (working)",
      shared: "Flagged for cross-agent pool",
    };
    return reasons[type];
  }

  /**
   * Like route(), but asks InnerThought to confirm ambiguous classifications.
   * Falls back to synchronous route() if InnerThought is unavailable.
   */
  async routeWithReasoning(
    content: string,
    hints?: Partial<RoutingDecision>,
  ): Promise<RoutingDecision> {
    const decision = this.route(content, hints);

    // Only call LLM when type was not explicitly provided and the best pattern
    // score is low (≤1 = one weak hit or pure fallback), meaning classification
    // is ambiguous. Score of 0 = no match at all; score of 1 = one regex hit
    // which is not reliable enough to be confident.
    const lowConfidence = this.bestScore(content) <= 1;
    if (hints?.type || !this.innerThought || !lowConfidence) {
      return decision;
    }

    const prompt = `Classify this memory as exactly one of: working, episodic, semantic, procedural, affective.
working = temporary task context (TTL-based)
episodic = personal events/experiences
semantic = facts, definitions, general knowledge
procedural = how-to steps, instructions
affective = emotionally significant moments

Memory: "${content.slice(0, 500)}"

Respond with only the type name, nothing else.`;

    const response = await this.innerThought.reason(prompt);
    const validTypes: MemoryType[] = [
      "working",
      "episodic",
      "semantic",
      "procedural",
      "affective",
    ];
    const refined = response?.toLowerCase().trim() as MemoryType;

    if (refined && validTypes.includes(refined)) {
      return {
        ...decision,
        type: refined,
        reasoning: `LLM-confirmed: ${refined}`,
      };
    }

    return decision;
  }
}
