import { createStore } from "../src/store/db";
import { defaultWorkspaceRoot, purgeRetainedWorkspace } from "../src/worker/workspace-lifecycle";

const args = process.argv.slice(2);
const itemId = args[0];
const actorFlag = args.indexOf("--actor");
const actor = actorFlag >= 0 ? args[actorFlag + 1] : undefined;
if (!itemId || itemId.startsWith("--") || !actor) {
  throw new Error("usage: bun run workspace:purge -- <work-item-id> --actor <operator-identity>");
}

const store = createStore(process.env.BOTTEGA_DB_PATH);
try {
  const workspacesDir = store.getOrgSettings()?.workspacesDir ?? defaultWorkspaceRoot();
  const result = await purgeRetainedWorkspace({ store, workspacesDir, itemId, actor });
  console.log(JSON.stringify(result));
} finally {
  store.close();
}
