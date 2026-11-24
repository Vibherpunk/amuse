export interface Agent {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  avatarStyle: string | null;
  vibe: string | null;
  emoji: string | null;
  hatchedAt: string | null;
  proactivity: string;
  status: string;
}
export interface Me {
  user: { id: string; name: string | null };
  agent: Agent;
  settings: any;
  usage: Usage;
  mainChatId: number;
}
export interface Usage {
  used: number;
  limit: number | null;
  remaining: number | null;
  percent: number;
  resetsAt: string;
}
export interface Message {
  id: number;
  chatId: number;
  role: "user" | "assistant" | "event" | "tool";
  content: string;
  parts: any[];
  runId: number | null;
  proactive: boolean;
  createdAt: string;
}
export interface Approval {
  id: number;
  runId: number | null;
  chatId: number | null;
  toolName: string;
  actionClass: string;
  target: string | null;
  purpose: string;
  details: Record<string, any>;
  options: string[];
  status: string;
  grant: string | null;
  createdAt: string;
}
export interface Goal {
  id: number;
  title: string;
  description: string;
  status: string;
  plan: { id: string; title: string; done: boolean }[];
  progressNote: string | null;
  emoji: string | null;
  updatedAt: string;
}
export interface Idea {
  id: number;
  title: string;
  body: string;
  prompt: string;
  category: string;
  emoji: string | null;
  source: string;
  status: string;
}
export interface Space {
  id: number;
  title: string;
  emoji: string | null;
  description: string;
  placement: "sidebar" | "tab" | "hidden";
  schedule: { days?: number[] } | null;
  position: number;
  lastRefreshedAt: string | null;
  updatedAt: string;
}
export interface Chat {
  id: number;
  kind: string;
  title: string;
  updatedAt: string;
}

export type DocBlockType = "p" | "h1" | "h2" | "h3" | "bullet" | "todo" | "callout" | "quote" | "code" | "divider";

export interface DocComment {
  id: string;
  author: "user" | "agent";
  text: string;
  selection?: string;
  createdAt: string;
  resolved?: boolean;
}

export interface DocBlock {
  id: string;
  type: DocBlockType;
  text: string;
  checked?: boolean;
  comments?: DocComment[];
}

export interface DocSummary {
  id: number;
  title: string;
  emoji: string;
  slug: string;
  updatedAt: string;
  createdAt: string;
  blockCount: number;
  preview: string;
}

export interface CollaborativeDoc {
  id: number;
  title: string;
  emoji: string;
  slug: string;
  blocks: DocBlock[];
  createdAt: string;
  updatedAt: string;
}
