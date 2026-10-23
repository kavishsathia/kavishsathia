import { freshKey, type Workbench } from "./units";

export type UnitExample = {
  id: string;
  label: string;
  blurb: string;
  schema: string;
  assumption: string;
  units: [name: string, predicate: string, symbol: string][];
  events: Record<string, string>[];
};

const AGENT_SCHEMA = "tool:string\nresource:string\namount:int";
const AGENT_ASSUMPTION = "tool in ['read_file', 'write_file', 'http_get', 'transfer'] && amount >= 0";

export const unitExamples: UnitExample[] = [
  {
    id: "agent-disjoint",
    label: "agent tool calls",
    blurb: "six units over tool calls; every pair is disjoint under the assumption",
    schema: AGENT_SCHEMA,
    assumption: AGENT_ASSUMPTION,
    units: [
      ["read_local", "tool == 'read_file' && !resource.startsWith('/etc/')", "fs.read"],
      ["read_system", "tool == 'read_file' && resource.startsWith('/etc/')", "fs.read_system"],
      ["write", "tool == 'write_file'", "fs.write"],
      ["fetch", "tool == 'http_get' && resource.startsWith('https://')", "net.get"],
      ["pay_small", "tool == 'transfer' && amount <= 100", "pay.small"],
      ["pay_large", "tool == 'transfer' && amount > 100", "pay.large"],
    ],
    events: [
      { tool: "'read_file'", resource: "'/home/k/notes.md'", amount: "0" },
      { tool: "'read_file'", resource: "'/etc/passwd'", amount: "0" },
      { tool: "'transfer'", resource: "'acct:42'", amount: "100" },
      { tool: "'transfer'", resource: "'acct:42'", amount: "101" },
      { tool: "'http_get'", resource: "'http://example.com'", amount: "0" },
      { tool: "'delete_file'", resource: "'/tmp/x'", amount: "0" },
    ],
  },
  {
    id: "agent-overlap",
    label: "overlaps",
    blurb: "read_any subsumes read_secret, and pay_large starts at 100 too: the solver finds an event each pair shares",
    schema: AGENT_SCHEMA,
    assumption: AGENT_ASSUMPTION,
    units: [
      ["read_any", "tool == 'read_file'", "fs.read"],
      ["read_secret", "tool == 'read_file' && resource.contains('secret')", "fs.read_secret"],
      ["pay_small", "tool == 'transfer' && amount <= 100", "pay.small"],
      ["pay_large", "tool == 'transfer' && amount >= 100", "pay.large"],
    ],
    events: [
      { tool: "'transfer'", resource: "'acct:42'", amount: "100" },
      { tool: "'read_file'", resource: "'/vault/secret.txt'", amount: "0" },
      { tool: "'write_file'", resource: "'/tmp/out'", amount: "0" },
    ],
  },
  {
    id: "boundaries",
    label: "vacuous, errors, bounds",
    blurb: "a unit the assumption rules out, a predicate that can error, and list quantifiers under an unroll bound",
    schema: "tool:string\ntags:list<string>\namount:int",
    assumption: "amount >= 0",
    units: [
      ["export_pii", "tool == 'export' && tags.exists(t, t == 'pii')", "export.pii"],
      ["export_plain", "tool == 'export' && tags.all(t, t != 'pii')", "export.plain"],
      ["refund", "tool == 'refund' && amount < 0", "pay.refund"],
      ["rate", "tool == 'rate' && 1000 / amount > 10", "rate.high"],
    ],
    events: [
      { tool: "'export'", tags: "['pii', 'eu']", amount: "0" },
      { tool: "'export'", tags: "[]", amount: "0" },
      { tool: "'rate'", tags: "[]", amount: "0" },
      { tool: "'export'", tags: "['eu']", amount: "'many'" },
    ],
  },
];

export function workbenchFrom(ex: UnitExample): Workbench {
  return {
    schema: ex.schema,
    assumption: ex.assumption,
    units: ex.units.map(([name, predicate, symbol]) => ({ key: freshKey("u"), name, predicate, symbol })),
    events: ex.events.map((values) => ({ key: freshKey("e"), values: { ...values } })),
    timeoutSec: 10,
    unroll: 5,
  };
}
