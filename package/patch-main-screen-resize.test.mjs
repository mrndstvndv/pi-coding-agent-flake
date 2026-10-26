import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { patchMainScreenResize } from "./patch-main-screen-resize.mjs";

test("patches readable and bundled conditions and rejects upstream drift", () => {
  for (const condition of ["heightChanged && !isTermuxSession()", "heightChanged&&!isTermuxSession()"] ) {
    const patched = patchMainScreenResize(`if (${condition}) fullRender(true);`, "fixture");
    assert.match(patched, /PI_TUI_INCREMENTAL_HEIGHT_RESIZE/);
    assert.throws(() => patchMainScreenResize(patched, "fixture"), /already patched/);
  }
  assert.throws(() => patchMainScreenResize("changed upstream", "fixture"), /found 0/);
  assert.throws(() => patchMainScreenResize("heightChanged&&!isTermuxSession();heightChanged&&!isTermuxSession()", "fixture"), /found 2/);
});

// Run against the pinned package in Nix builds, or PI_RESIZE_TEST_PACKAGE_ROOT=/path/to/package locally.
const packageRoot = process.env.PI_RESIZE_TEST_PACKAGE_ROOT;
if (packageRoot) {
  const rendererPath = path.join(packageRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "tui-main-screen.js");
  const rendererSource = patchMainScreenResize(readFileSync(rendererPath, "utf8"), rendererPath)
    .replace(/from "(\.\/[^\"]+)"/g, (_, specifier) => `from ${JSON.stringify(new URL(specifier, pathToFileURL(rendererPath)).href)}`);
  const { TuiMainScreen } = await import(`data:text/javascript;base64,${Buffer.from(rendererSource).toString("base64")}`);

  function withPolicy(policy, callback) {
    const previousPolicy = process.env.PI_TUI_INCREMENTAL_HEIGHT_RESIZE;
    const previousTermux = process.env.TERMUX_VERSION;
    process.env.PI_TUI_INCREMENTAL_HEIGHT_RESIZE = policy;
    delete process.env.TERMUX_VERSION;
    try {
      callback();
    } finally {
      if (previousPolicy === undefined) delete process.env.PI_TUI_INCREMENTAL_HEIGHT_RESIZE;
      else process.env.PI_TUI_INCREMENTAL_HEIGHT_RESIZE = previousPolicy;
      if (previousTermux === undefined) delete process.env.TERMUX_VERSION;
      else process.env.TERMUX_VERSION = previousTermux;
    }
  }

  function createRenderer() {
    const writes = [];
    const terminal = {
      columns: 80,
      rows: 40,
      write: (data) => writes.push(data),
      hideCursor() {},
      showCursor() {},
    };
    const lines = Array.from({ length: 1000 }, (_, index) => `history ${index}`);
    lines[10] = `\x1b_Ga=T,f=100,i=42,c=10,r=1;${"A".repeat(1024 * 1024)}\x1b\\`;
    const renderer = new TuiMainScreen(terminal);
    renderer.addChild({ render: () => [...lines], invalidate() {} });
    renderer.doRender();
    assert.ok(writes.join("").length > 1024 * 1024);
    writes.length = 0;
    return { renderer, terminal, lines, writes };
  }

  test("repeated height resizes preserve long history and do not retransmit images", () => withPolicy("1", () => {
    const { renderer, terminal, lines, writes } = createRenderer();
    for (const rows of [25, 40, 15, 40]) {
      terminal.rows = rows;
      renderer.doRender();
      assert.equal(renderer.fullRedraws, 1);
      assert.ok(writes.join("").length < 1024);
      assert.doesNotMatch(writes.join(""), /\x1b\[3J|\x1b_G/);
      writes.length = 0;
    }
    terminal.rows = 25;
    lines[lines.length - 1] = "updated footer";
    renderer.doRender();
    assert.equal(renderer.fullRedraws, 1);
    assert.match(writes.join(""), /updated footer/);
    assert.ok(writes.join("").length < 1024);
    assert.doesNotMatch(writes.join(""), /\x1b_G/);
  }));

  test("width changes still redraw wrapped history", () => withPolicy("1", () => {
    const { renderer, terminal, writes } = createRenderer();
    terminal.columns = 60;
    renderer.doRender();
    assert.equal(renderer.fullRedraws, 2);
    assert.match(writes.join(""), /\x1b\[3J/);
    assert.ok(writes.join("").length > 1024 * 1024);
  }));

  test("opting out retains upstream height-resize behavior", () => withPolicy("0", () => {
    const { renderer, terminal, writes } = createRenderer();
    terminal.rows = 25;
    renderer.doRender();
    assert.equal(renderer.fullRedraws, 2);
    assert.ok(writes.join("").length > 1024 * 1024);
  }));
}
