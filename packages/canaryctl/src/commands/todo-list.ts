import { listTodos } from "@canaryctl/core";
import type { TodoRecord } from "@canaryctl/core";
import { printJson } from "../output/render.js";
import { withConnection } from "./context.js";
import { normalizeProjectPath } from "./target.js";

interface TodoListInput {
  cwd: string;
  file?: string;
  limit?: number;
  json?: boolean;
}

function printTodoList(items: TodoRecord[]): void {
  if (items.length === 0) {
    process.stdout.write("No todos.\n");
    return;
  }

  for (const item of items) {
    const location = item.filePath ?? "project";
    const pending = item.pendingFor ? ` · pending:${item.pendingFor}` : "";
    process.stdout.write(
      `${item.kind}  ${item.title}\n${location} · ${item.freshness}${pending}\n\n`
    );
  }
}

export async function runTodoList(input: TodoListInput): Promise<void> {
  await withConnection(input.cwd, async ({ connection, projectRoot }) => {
    const filePath = input.file ? normalizeProjectPath(projectRoot, input.file) : undefined;
    const items = await listTodos(connection, {
      limit: input.limit,
      filePath
    });

    if (input.json) {
      printJson(items);
      return;
    }

    printTodoList(items);
  });
}
