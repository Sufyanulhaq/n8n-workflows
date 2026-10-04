// Draws each workflow as a flow chart straight from the exported file, so the diagram cannot drift
// from what is really in the workflow. Run: node scripts/mermaid.js  (writes docs/diagrams.md)
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "workflows");
const kind = (t) => t.replace("n8n-nodes-base.", "");
const shape = { webhook: ["([", "])"], manualTrigger: ["([", "])"], scheduleTrigger: ["([", "])"], if: ["{", "}"], httpRequest: ["[[", "]]"], respondToWebhook: ["([", "])"] };

let out = "# Workflow diagrams\n\nGenerated from the files in `workflows/` by `node scripts/mermaid.js`. Rounded boxes start or end a run, diamonds are decisions, double edged boxes call another system.\n";
for (const file of fs.readdirSync(dir).sort()) {
  const wf = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const ids = new Map(wf.nodes.map((n, i) => [n.name, `n${i}`]));
  out += `\n## ${wf.name}\n\n\`\`\`mermaid\nflowchart TD\n`;
  for (const n of wf.nodes) {
    const [a, b] = shape[kind(n.type)] || ["[", "]"];
    out += `  ${ids.get(n.name)}${a}"${n.name.replace(/"/g, "'")}"${b}\n`;
  }
  for (const [from, { main }] of Object.entries(wf.connections)) {
    const isIf = kind(wf.nodes.find((n) => n.name === from).type) === "if";
    main.forEach((targets, i) => targets.forEach((t) => {
      out += `  ${ids.get(from)} -->${isIf ? `|${i === 0 ? "yes" : "no"}|` : ""} ${ids.get(t.node)}\n`;
    }));
  }
  out += "```\n";
}
fs.writeFileSync(path.join(__dirname, "..", "docs", "diagrams.md"), out);
console.log("docs/diagrams.md written");
