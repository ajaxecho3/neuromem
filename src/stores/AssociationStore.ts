/**
 * AssociationStore — Entorhinal Cortex analog (Neo4j)
 *
 * Stores relationships BETWEEN memories as a graph. Lets us do
 * spreading-activation recall: "find me memories connected to X
 * within 2 hops."
 */

import neo4j, { type Driver } from "neo4j-driver";
import { config } from "../utils/config.js";

export class AssociationStore {
  private driver: Driver;

  constructor() {
    this.driver = neo4j.driver(
      config.neo4j.uri,
      neo4j.auth.basic(config.neo4j.user, config.neo4j.password),
    );
  }

  private async waitForBolt(retries = 10, delayMs = 3000): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await this.driver.verifyConnectivity();
        return;
      } catch (err) {
        if (i === retries - 1) throw err;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  async init(): Promise<void> {
    await this.waitForBolt();
    const session = this.driver.session();
    try {
      // Constraints + indexes
      await session.run(`
        CREATE CONSTRAINT memory_id IF NOT EXISTS
          FOR (m:Memory) REQUIRE m.id IS UNIQUE
      `);
      await session.run(`
        CREATE INDEX memory_agent IF NOT EXISTS
          FOR (m:Memory) ON (m.agent_id)
      `);
      await session.run(`
        CREATE INDEX memory_type IF NOT EXISTS
          FOR (m:Memory) ON (m.type)
      `);
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  /** Register a memory node (idempotent) */
  async registerMemory(params: {
    id: string;
    agent_id: string;
    type: string;
    title: string;
    tags: string[];
  }): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MERGE (m:Memory {id: $id})
         SET m.agent_id = $agent_id,
             m.type = $type,
             m.title = $title,
             m.tags = $tags,
             m.created_at = coalesce(m.created_at, datetime())`,
        params,
      );
    } finally {
      await session.close();
    }
  }

  /** Create a bidirectional association (RELATES_TO edge) */
  async associate(
    id_a: string,
    id_b: string,
    weight = 1.0,
    kind = "RELATES_TO",
  ): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MATCH (a:Memory {id: $id_a}), (b:Memory {id: $id_b})
         MERGE (a)-[r:${sanitize(kind)}]-(b)
         ON CREATE SET r.weight = $weight, r.created_at = datetime()
         ON MATCH  SET r.weight = r.weight + $weight * 0.1`,
        { id_a, id_b, weight },
      );
    } finally {
      await session.close();
    }
  }

  /** Find IDs of memories within N hops of a given memory */
  async findRelated(id: string, hops = 2, limit = 20): Promise<string[]> {
    const session = this.driver.session();
    try {
      const res = await session.run(
        `MATCH (start:Memory {id: $id})-[*1..${hops}]-(related:Memory)
         WHERE related.id <> $id
         RETURN DISTINCT related.id AS id
         LIMIT ${limit}`,
        { id },
      );
      return res.records.map((r) => r.get("id") as string);
    } finally {
      await session.close();
    }
  }

  /** Delete a memory node + all its edges */
  async forget(id: string): Promise<boolean> {
    const session = this.driver.session();
    try {
      const res = await session.run(
        `MATCH (m:Memory {id: $id}) DETACH DELETE m RETURN count(m) AS n`,
        { id },
      );
      return (res.records[0]?.get("n").toNumber() ?? 0) > 0;
    } finally {
      await session.close();
    }
  }

  /** Graph stats for reflect() */
  async stats(agent_id: string): Promise<{ nodes: number; edges: number }> {
    const session = this.driver.session();
    try {
      const nodesRes = await session.run(
        `MATCH (m:Memory {agent_id: $agent_id}) RETURN count(m) AS n`,
        { agent_id },
      );
      const edgesRes = await session.run(
        `MATCH (a:Memory {agent_id: $agent_id})-[r]-(b:Memory)
         RETURN count(DISTINCT r) AS n`,
        { agent_id },
      );
      return {
        nodes: nodesRes.records[0]?.get("n").toNumber() ?? 0,
        edges: edgesRes.records[0]?.get("n").toNumber() ?? 0,
      };
    } finally {
      await session.close();
    }
  }

  async listNodesAndEdges(agent_id: string): Promise<{
    nodes: Array<{ id: string; type: string }>;
    edges: Array<{ source: string; target: string; label?: string }>;
  }> {
    const session = this.driver.session();
    try {
      const nodesRes = await session.run(
        `MATCH (m:Memory {agent_id: $agent_id}) RETURN m.id AS id, m.type AS type`,
        { agent_id },
      );
      const edgesRes = await session.run(
        `MATCH (a:Memory {agent_id: $agent_id})-[r]->(b:Memory)
         RETURN a.id AS source, b.id AS target, type(r) AS relType`,
        { agent_id },
      );
      return {
        nodes: nodesRes.records.map((r) => ({
          id: r.get("id") as string,
          type: r.get("type") as string,
        })),
        edges: edgesRes.records.map((r) => ({
          source: r.get("source") as string,
          target: r.get("target") as string,
          label: (r.get("relType") as string).toLowerCase().replace(/_/g, " "),
        })),
      };
    } finally {
      await session.close();
    }
  }
}

// Neo4j relationship types can't be parameterized, so whitelist
function sanitize(kind: string): string {
  return kind.replace(/[^A-Z_]/gi, "").toUpperCase() || "RELATES_TO";
}
