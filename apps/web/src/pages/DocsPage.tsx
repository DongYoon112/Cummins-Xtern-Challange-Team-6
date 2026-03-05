export function DocsPage() {
  const sections = [
    { id: "quickstart", label: "Quickstart" },
    { id: "repos", label: "Repositories" },
    { id: "ai-builder", label: "AI Builder" },
    { id: "nodes", label: "Node Reference" },
    { id: "external-db", label: "External DB" },
    { id: "test-workflow", label: "Test Workflow" },
    { id: "run-monitor", label: "Run and Monitor" }
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[220px,1fr]">
      <aside className="h-fit rounded border border-slate-200 bg-white p-3 lg:sticky lg:top-4">
        <h2 className="text-sm font-semibold">Docs</h2>
        <div className="mt-2 space-y-1">
          {sections.map((section) => (
            <a
              className="block rounded px-2 py-1 text-sm text-slate-700 hover:bg-slate-100"
              href={`#${section.id}`}
              key={section.id}
            >
              {section.label}
            </a>
          ))}
        </div>
      </aside>

      <div className="space-y-4">
        <section className="rounded border border-slate-200 bg-white p-4" id="quickstart">
          <h3 className="text-base font-semibold">Quickstart</h3>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-slate-700">
            <li>
              Run <code>pnpm dev</code> and open <code>http://localhost:5173</code>.
            </li>
            <li>
              Sign in with <code>admin/admin123</code> for full access.
            </li>
            <li>
              Open <code>Workflows</code> and use <code>Dashboard</code> as your repository list.
            </li>
          </ol>
        </section>

        <section className="rounded border border-slate-200 bg-white p-4" id="repos">
          <h3 className="text-base font-semibold">Repositories</h3>
          <p className="mt-2 text-sm text-slate-700">
            Workflow repositories are the top-level containers for your workflow drafts and published versions.
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li>Use <code>New Repository</code> to create one (GitHub-style name + description).</li>
            <li>Double-click a row in Dashboard to open that repository in Builder.</li>
            <li>Use <code>Save Draft</code> for draft state and <code>Publish</code> to add versions to repo list.</li>
          </ul>
        </section>

        <section className="rounded border border-slate-200 bg-white p-4" id="ai-builder">
          <h3 className="text-base font-semibold">AI Builder</h3>
          <p className="mt-2 text-sm text-slate-700">
            In Builder mode, use <code>AI Builder</code> to generate or refine a graph from natural language.
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li>Choose template, allowed tools, risk level, and provider.</li>
            <li>Click <code>Generate Draft</code> to replace current graph with AI output.</li>
            <li>Use <code>Refine</code> with feedback text to adjust an existing graph.</li>
            <li>Review returned notes/risks, then <code>Publish</code> and <code>Run Latest</code>.</li>
          </ul>
        </section>

        <section className="rounded border border-slate-200 bg-white p-4" id="nodes">
          <h3 className="text-base font-semibold">Node Reference</h3>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm">
              <div className="font-semibold">Start</div>
              <p className="mt-1 text-slate-700">Entry point of the graph. Required exactly once.</p>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm">
              <div className="font-semibold">LLM</div>
              <p className="mt-1 text-slate-700">Model reasoning/generation step using configured provider and model.</p>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm">
              <div className="font-semibold">Tool</div>
              <p className="mt-1 text-slate-700">External integration/tool call, linked to enabled tool config.</p>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm">
              <div className="font-semibold">Router</div>
              <p className="mt-1 text-slate-700">Decision/gating step based on a condition expression.</p>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm">
              <div className="font-semibold">Memory</div>
              <p className="mt-1 text-slate-700">Context retention strategy for session or workflow state.</p>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm">
              <div className="font-semibold">Debate</div>
              <p className="mt-1 text-slate-700">
                Runs multi-model debate rounds and synthesizes one recommendation.
              </p>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm">
              <div className="font-semibold">Output</div>
              <p className="mt-1 text-slate-700">Final result node. At least one reachable Output is required.</p>
            </div>
          </div>
        </section>

        <section className="rounded border border-slate-200 bg-white p-4" id="external-db">
          <h3 className="text-base font-semibold">External DB</h3>
          <p className="mt-2 text-sm text-slate-700">
            Tool nodes can run read-only SQL against external PostgreSQL or SQLite.
          </p>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-slate-700">
            <li>
              Enable <code>Database</code> in Developer mode tools and set its <code>connectionString</code>, or set{" "}
              <code>External Database URL</code> in <code>Settings</code> (stored encrypted), or set{" "}
              <code>EXTERNAL_DB_URL</code> in <code>.env</code>.
            </li>
            <li>
              In Flowchart, add a <code>Tool</code> node, link it to <code>Database</code>, then set:
              <code>query</code>, optional <code>queryParams</code> (JSON array), and <code>maxRows</code>.
            </li>
            <li>
              Only read-only SQL is allowed (<code>SELECT</code>/<code>WITH</code>/<code>PRAGMA</code>).
            </li>
            <li>
              Publish and run. Output will include <code>rowCount</code> and <code>rows</code>.
            </li>
          </ol>
          <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
            <div className="font-semibold">PostgreSQL example</div>
            <pre className="mt-2 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100">
{`connectionString: postgresql://user:pass@host:5432/mydb
query: SELECT id, status, created_at FROM jobs ORDER BY created_at DESC LIMIT 20
queryParams: []
maxRows: 100`}
            </pre>
          </div>
        </section>

        <section className="rounded border border-slate-200 bg-white p-4" id="test-workflow">
          <h3 className="text-base font-semibold">Test Workflow</h3>
          <p className="mt-2 text-sm text-slate-700">Recommended first test graph:</p>
          <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
            <code>Start {"->"} LLM {"->"} Output</code>
          </div>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li>Create/select repository from Dashboard.</li>
            <li>Open Builder and connect nodes in order.</li>
            <li>Set node label/description as needed.</li>
            <li>Click <code>Publish</code>.</li>
          </ul>
        </section>

        <section className="rounded border border-slate-200 bg-white p-4" id="run-monitor">
          <h3 className="text-base font-semibold">Run and Monitor</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li>Open <code>Run</code> tab, select workflow, and click <code>Start Run</code>.</li>
            <li>If status is <code>WAITING_APPROVAL</code>, resolve in <code>Approvals</code>.</li>
            <li>Use <code>Audit Log</code> to inspect/export execution records.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
