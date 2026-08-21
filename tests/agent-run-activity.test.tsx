import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentRunActivity } from "../src/renderer/AgentRunActivity";
import type { AgentToolActivity } from "../src/renderer/use-agent-chat";

const activities: AgentToolActivity[] = [
  {
    invocationId: "invocation-1",
    toolName: "task_list",
    status: "succeeded",
    risk: "R0",
    preview: { action: "list-tasks", scope: "today" },
    timestamp: new Date().toISOString(),
  },
  {
    invocationId: "invocation-2",
    toolName: "task_bulk_update",
    status: "awaiting-approval",
    risk: "R2",
    preview: { count: 3, action: "move-to-today" },
    timestamp: new Date().toISOString(),
  },
];

describe("AgentRunActivity", () => {
  it("shows tool family, trusted status, risk and an optional impact preview", () => {
    const { container } = render(
      <AgentRunActivity activities={activities} active />,
    );

    expect(screen.getByRole("region", { name: "Agent 执行过程" })).toBeVisible();
    expect(screen.getAllByText("任务工具")).toHaveLength(2);
    expect(screen.getByText(/已完成/u)).toBeVisible();
    expect(screen.getByText(/等待确认/u)).toBeVisible();
    expect(screen.getByText("R2")).toBeVisible();
    expect(container.querySelectorAll("code")).toHaveLength(2);

    fireEvent.click(screen.getAllByText("查看影响预览")[0]);
    expect(screen.getByText(/list-tasks/)).toBeVisible();
  });

  it("renders nothing when no tool has been proposed", () => {
    const { container } = render(<AgentRunActivity activities={[]} active={false} />);
    expect(container.firstChild).toBeNull();
  });
});
