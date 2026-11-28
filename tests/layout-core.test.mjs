import assert from "node:assert/strict";
import { test } from "node:test";
import { demoHomeLayout } from "../src/layout/demo/demoHomeLayout.ts";
import {
  validateLayoutConfig,
} from "../src/layout/schema/validateLayoutConfig.ts";
import {
  alignCanvasRect,
  alignResizedCanvasRect,
  defaultCanvasInteractionPreferences,
  isValidCanvasRect,
  isValidSpacingPx,
  measureCanvasRectDistance,
  moveCanvasItemLayer,
  resizeCanvasRect,
  updateCanvasRect,
  updateResponsiveCanvasRect,
  updateCanvasGesture,
} from "../src/layout/engine/index.ts";
import {
  addBlock,
  addColumn,
  addRow,
  deleteBlock,
  deleteColumn,
  moveBlock,
  moveColumn,
  moveRow,
} from "../src/layout/editor/layoutOperations.ts";
import {
  convertPageToFreeLayout,
  deleteDetachedIcon,
  ensureFreeLayoutGeometry,
  listFreeLayoutItems,
  setButtonIcon,
  updateLayoutNodeLayer,
  updateLayoutNodeRect,
} from "../src/layout/editor/freeLayout.ts";
import { LocalStorageLayoutRepository } from "../src/layout/storage/LocalStorageLayoutRepository.ts";
import {
  commitHistory,
  createHistory,
  redoHistory,
  undoHistory,
} from "../src/layout/history.ts";

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }
}

function snapshotFreeGeometry(page) {
  return Object.fromEntries(
    ["desktop", "tablet", "mobile"].map((profile) => [
      profile,
      listFreeLayoutItems(page, profile).map(({ id, rect, zIndex }) => ({
        id,
        rect,
        zIndex,
      })),
    ]),
  );
}

test("accepts the demonstration layout", () => {
  assert.equal(validateLayoutConfig(demoHomeLayout).valid, true);
});

test("rejects unsupported versions, unknown blocks, and invalid grid spans", () => {
  const unsupportedVersion = structuredClone(demoHomeLayout);
  unsupportedVersion.schemaVersion = 4;
  assert.equal(validateLayoutConfig(unsupportedVersion).valid, false);

  const unknownBlock = structuredClone(demoHomeLayout);
  unknownBlock.pages[0].rows[0].columns[0].blocks[0].type = "html";
  assert.equal(validateLayoutConfig(unknownBlock).valid, false);

  const invalidSpan = structuredClone(demoHomeLayout);
  invalidSpan.pages[0].rows[0].columns[0].span.mobile = 13;
  assert.equal(validateLayoutConfig(invalidSpan).valid, false);
});

test("migrates valid version 1 layouts through version 2 into version 3", () => {
  const legacyLayout = {
    schemaVersion: 1,
    layoutId: "legacy-home",
    pages: [
      {
        id: "home",
        title: "Accueil",
        order: 0,
        rows: [
          {
            type: "row",
            id: "row-main",
            columns: [
              {
                type: "column",
                id: "column-main",
                span: { mobile: 12, tablet: 12, desktop: 12 },
                blocks: [
                  {
                    type: "button",
                    id: "launch-button",
                    label: "Tester",
                    actionId: "demo.noop",
                    variant: "primary",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const result = validateLayoutConfig(legacyLayout);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.value.schemaVersion, 3);
    assert.equal(result.value.pages[0].layoutMode, "flow");
    assert.equal(result.value.pages[0].rows[0].name, "Ligne 1");
    assert.equal(
      result.value.pages[0].rows[0].columns[0].blocks[0].name,
      "Bouton",
    );
  }
});

test("migrates saved version 2 layouts without changing their content or actions", async () => {
  const legacyLayout = structuredClone(demoHomeLayout);
  legacyLayout.schemaVersion = 2;
  for (const page of legacyLayout.pages) {
    delete page.layoutMode;
  }
  legacyLayout.pages[0].rows[1].columns[0].blocks[1].iconId = "check";
  const originalPages = structuredClone(legacyLayout.pages);

  const result = validateLayoutConfig(legacyLayout);
  assert.equal(result.valid, true);
  if (!result.valid) {
    return;
  }

  assert.equal(result.value.schemaVersion, 3);
  assert.deepEqual(
    result.value.pages,
    originalPages.map((page) => ({ ...page, layoutMode: "flow" })),
  );
  assert.equal(
    result.value.pages[0].rows[1].columns[0].blocks[1].actionId,
    "demo.show-welcome",
  );
  assert.equal(
    result.value.pages[0].rows[1].columns[0].blocks[1].iconId,
    "check",
  );
  assert.deepEqual(legacyLayout.pages, originalPages);

  const storage = new MemoryStorage();
  storage.setItem(
    "bonobos.layout.repository.v1:demo-home",
    JSON.stringify({
      recordVersion: 1,
      draft: legacyLayout,
      published: legacyLayout,
      revisions: [],
    }),
  );
  const repository = new LocalStorageLayoutRepository(storage);
  assert.deepEqual(await repository.loadDraft("demo-home"), result.value);
  assert.deepEqual(await repository.loadPublished("demo-home"), result.value);
});

test("validates free layouts with precise independent responsive geometry", () => {
  const freeLayout = structuredClone(demoHomeLayout);
  const page = freeLayout.pages[0];
  page.layoutMode = "free";

  let zIndex = 0;
  for (const row of page.rows) {
    row.placement = {
      desktop: { x: -0.5, y: 1.25, width: 900.5, height: 140.25 },
      tablet: { x: 2.5, y: 3.75, width: 700.25, height: 120.5 },
      mobile: { x: 0.125, y: 9.5, width: 360.75, height: 90.25 },
    };
    row.zIndex = zIndex++;
    for (const column of row.columns) {
      column.placement = {
        desktop: { x: 4.5, y: 5.25, width: 400.75, height: 80.125 },
        tablet: { x: 3.25, y: 6.5, width: 300.5, height: 70.75 },
        mobile: { x: 2.75, y: 7.125, width: 200.25, height: 60.5 },
      };
      column.zIndex = zIndex++;
      for (const block of column.blocks) {
        block.placement = {
          desktop: { x: 10.25, y: 12.5, width: 150.75, height: 40.125 },
          tablet: { x: 11.5, y: 13.25, width: 140.5, height: 35.75 },
          mobile: { x: 12.75, y: 14.5, width: 130.25, height: 30.5 },
        };
        block.zIndex = zIndex++;
        block.spacingPx = 2.375;
        if (block.type === "button") {
          block.detachedIcon = {
            type: "icon",
            id: "welcome-icon",
            iconId: "check",
            placement: {
              desktop: { x: 2.5, y: 1.25, width: 16.5, height: 16.5 },
              tablet: { x: 3.5, y: 2.25, width: 14.5, height: 14.5 },
              mobile: { x: 4.5, y: 3.25, width: 12.5, height: 12.5 },
            },
            zIndex: zIndex++,
          };
        }
      }
    }
  }

  const result = validateLayoutConfig(freeLayout);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(
      result.value.pages[0].rows[0].columns[0].blocks[0].placement.desktop.x,
      10.25,
    );
    assert.equal(
      result.value.pages[0].rows[0].columns[0].blocks[0].placement.tablet.x,
      11.5,
    );
    assert.equal(
      result.value.pages[0].rows[0].columns[0].blocks[0].placement.mobile.x,
      12.75,
    );
    assert.equal(
      result.value.pages[0].rows[0].columns[0].blocks[0].spacingPx,
      2.375,
    );
  }

  const duplicateIconId = structuredClone(freeLayout);
  const button = duplicateIconId.pages[0].rows[1].columns[0].blocks[1];
  button.detachedIcon.id = button.id;
  const duplicateIds = validateLayoutConfig(duplicateIconId);
  assert.equal(duplicateIds.valid, false);
  if (!duplicateIds.valid) {
    assert.ok(duplicateIds.issues.some((issue) => /duplicate node id/.test(issue.message)));
  }
});

test("does not apply the 12-column grid limit to free-layout objects", () => {
  const freeLayout = structuredClone(demoHomeLayout);
  const page = freeLayout.pages[0];
  page.layoutMode = "free";
  page.rows = [
    {
      type: "row",
      id: "free-row",
      placement: {
        desktop: { x: 0, y: 0, width: 1000, height: 100 },
        tablet: { x: 0, y: 0, width: 800, height: 100 },
        mobile: { x: 0, y: 0, width: 400, height: 100 },
      },
      zIndex: 0,
      columns: Array.from({ length: 13 }, (_, index) => ({
        type: "column",
        id: `free-column-${index}`,
        blocks: [],
        placement: {
          desktop: { x: index * 10, y: 0, width: 30, height: 30 },
          tablet: { x: index * 10, y: 0, width: 30, height: 30 },
          mobile: { x: index * 10, y: 0, width: 30, height: 30 },
        },
        zIndex: index + 1,
      })),
    },
  ];

  assert.equal(validateLayoutConfig(freeLayout).valid, true);

  let flowLayout = structuredClone(demoHomeLayout);
  const flowPageId = flowLayout.pages[0].id;
  const flowRowId = flowLayout.pages[0].rows[0].id;
  while (flowLayout.pages[0].rows[0].columns.length < 12) {
    flowLayout = addColumn(flowLayout, flowPageId, flowRowId);
  }
  assert.throws(
    () => addColumn(flowLayout, flowPageId, flowRowId),
    /more than 12 columns/,
  );
});

test("converts flow pages to responsive free placement without changing actions", () => {
  const legacyPage = structuredClone(demoHomeLayout.pages[0]);
  const button =
    legacyPage.rows[1].columns[0].blocks.find((block) => block.type === "button");
  button.iconId = "check";
  const original = structuredClone(legacyPage);

  const freePage = convertPageToFreeLayout(legacyPage, () => "detached-check");
  const freeButton =
    freePage.rows[1].columns[0].blocks.find((block) => block.type === "button");

  assert.equal(freePage.layoutMode, "free");
  assert.deepEqual(legacyPage, original);
  assert.equal(freeButton.actionId, button.actionId);
  assert.equal(freeButton.iconId, undefined);
  assert.equal(freeButton.detachedIcon.iconId, "check");
  assert.equal(freeButton.detachedIcon.id, "detached-check");
  assert.deepEqual(
    Object.keys(freeButton.placement).sort(),
    ["desktop", "mobile", "tablet"],
  );
  assert.notEqual(
    freeButton.placement.desktop.width,
    freeButton.placement.mobile.width,
  );
  assert.equal(
    validateLayoutConfig({
      ...demoHomeLayout,
      pages: [freePage],
    }).valid,
    true,
  );
});

test("preserves free geometry across flow edits and initializes new flow items", () => {
  const sourcePage = structuredClone(demoHomeLayout.pages[0]);
  const sourceButton =
    sourcePage.rows[1].columns[0].blocks.find((block) => block.type === "button");
  sourceButton.iconId = "check";
  const freePage = convertPageToFreeLayout(sourcePage, () => "roundtrip-icon");
  const row = freePage.rows[0];
  const column = row.columns[0];
  const button =
    freePage.rows[1].columns[0].blocks.find((block) => block.type === "button");
  row.placement.desktop = { x: 1.125, y: 2.25, width: 901.5, height: 141.75 };
  row.zIndex = 100;
  column.placement.mobile = { x: 3.5, y: 4.25, width: 350.75, height: 120.5 };
  column.zIndex = 101;
  button.placement = {
    desktop: { x: 15.25, y: 25.5, width: 260.75, height: 55.125 },
    tablet: { x: 10.5, y: 20.25, width: 240.5, height: 50.75 },
    mobile: { x: 5.125, y: 12.5, width: 180.25, height: 45.5 },
  };
  button.zIndex = 102;
  button.detachedIcon.placement.desktop = {
    x: 22.125,
    y: 43.25,
    width: 18.5,
    height: 18.5,
  };
  button.detachedIcon.zIndex = 103;
  const expectedGeometry = snapshotFreeGeometry(freePage);

  const flowPage = {
    ...freePage,
    layoutMode: "flow",
    rows: freePage.rows.map((candidate) =>
      candidate.id === row.id
        ? {
            ...candidate,
            columns: candidate.columns.map((candidateColumn, index) =>
              index === 0
                ? {
                    ...candidateColumn,
                    span: { ...candidateColumn.span, desktop: 6 },
                  }
                : candidateColumn,
            ),
          }
        : candidate,
    ),
  };
  let flowLayout = { ...demoHomeLayout, pages: [flowPage] };
  flowLayout = addRow(flowLayout, flowPage.id);
  const expandedRow =
    flowLayout.pages[0].rows[flowLayout.pages[0].rows.length - 1];
  const newColumn = expandedRow.columns[0];
  flowLayout = addBlock(
    flowLayout,
    flowPage.id,
    expandedRow.id,
    newColumn.id,
    "text",
  );
  const returnedPage = convertPageToFreeLayout(
    flowLayout.pages[0],
    () => "unused-icon-id",
  );

  for (const profile of ["desktop", "tablet", "mobile"]) {
    const restoredById = new Map(
      snapshotFreeGeometry(returnedPage)[profile].map((item) => [
        item.id,
        item,
      ]),
    );
    for (const item of expectedGeometry[profile]) {
      assert.deepEqual(restoredById.get(item.id), item);
    }
  }
  assert.equal(returnedPage.rows[0].columns[0].span.desktop, 6);
  assert.equal(
    returnedPage.rows[1].columns[0].blocks.find(
      (candidate) => candidate.id === button.id,
    ).actionId,
    sourceButton.actionId,
  );
  const returnedButton = returnedPage.rows[1].columns[0].blocks.find(
    (candidate) => candidate.id === button.id,
  );
  assert.equal(returnedButton.detachedIcon.id, "roundtrip-icon");
  assert.equal(returnedButton.detachedIcon.iconId, "check");
  const returnedNewRow = returnedPage.rows.find(
    (candidate) => candidate.id === expandedRow.id,
  );
  assert.deepEqual(Object.keys(returnedNewRow.placement).sort(), [
    "desktop",
    "mobile",
    "tablet",
  ]);
  assert.equal(Number.isInteger(returnedNewRow.zIndex), true);
  const returnedNewColumn = returnedNewRow.columns.find(
    (candidate) => candidate.id === newColumn.id,
  );
  assert.deepEqual(Object.keys(returnedNewColumn.placement).sort(), [
    "desktop",
    "mobile",
    "tablet",
  ]);
  assert.equal(Number.isInteger(returnedNewColumn.zIndex), true);
  const returnedNewBlock = returnedNewColumn.blocks[0];
  assert.deepEqual(Object.keys(returnedNewBlock.placement).sort(), [
    "desktop",
    "mobile",
    "tablet",
  ]);
  assert.equal(Number.isInteger(returnedNewBlock.zIndex), true);
});

test("initializes geometry for new free-layout items and allows more than 12 columns", () => {
  const freePage = convertPageToFreeLayout(
    structuredClone(demoHomeLayout.pages[0]),
    () => "icon-unused",
  );
  let nextLayout = { ...demoHomeLayout, pages: [freePage] };
  const rowId = freePage.rows[0].id;

  for (let index = 0; index < 11; index += 1) {
    nextLayout = addColumn(nextLayout, freePage.id, rowId);
  }
  const expandedPage = ensureFreeLayoutGeometry(nextLayout.pages[0]);
  nextLayout = {
    ...nextLayout,
    pages: [expandedPage],
  };
  assert.equal(expandedPage.rows[0].columns.length, 13);
  assert.equal(validateLayoutConfig(nextLayout).valid, true);

  const newColumnId = expandedPage.rows[0].columns[12].id;
  const withBlock = addBlock(
    nextLayout,
    freePage.id,
    rowId,
    newColumnId,
    "button",
  );
  const initialized = ensureFreeLayoutGeometry(withBlock.pages[0]);
  const newBlock = initialized.rows[0].columns[12].blocks[0];
  assert.deepEqual(Object.keys(newBlock.placement).sort(), [
    "desktop",
    "mobile",
    "tablet",
  ]);
  assert.equal(Number.isInteger(newBlock.zIndex), true);
  assert.equal(
    validateLayoutConfig({ ...withBlock, pages: [initialized] }).valid,
    true,
  );
});

test("updates a single free profile, orders items, and edits detached icons independently", () => {
  const sourcePage = structuredClone(demoHomeLayout.pages[0]);
  const sourceButton =
    sourcePage.rows[1].columns[0].blocks.find((block) => block.type === "button");
  sourceButton.iconId = "check";
  const freePage = convertPageToFreeLayout(
    sourcePage,
    () => "detached-check",
  );
  const button =
    freePage.rows[1].columns[0].blocks.find((block) => block.type === "button");
  const layout = { ...demoHomeLayout, pages: [freePage] };
  const selection = {
    kind: "block",
    pageId: freePage.id,
    rowId: freePage.rows[1].id,
    columnId: freePage.rows[1].columns[0].id,
    blockId: button.id,
  };
  const originalDesktop = structuredClone(button.placement.desktop);
  const originalMobile = structuredClone(button.placement.mobile);
  const resized = updateLayoutNodeRect(layout, selection, "tablet", {
    ...button.placement.tablet,
    x: 21.375,
    width: 333.125,
  });
  const resizedButton =
    resized.pages[0].rows[1].columns[0].blocks.find((block) => block.id === button.id);
  assert.deepEqual(resizedButton.placement.desktop, originalDesktop);
  assert.deepEqual(resizedButton.placement.mobile, originalMobile);
  assert.equal(resizedButton.placement.tablet.x, 21.375);

  const front = updateLayoutNodeLayer(
    resized,
    resized.pages[0],
    selection,
    "front",
  );
  const frontButton =
    front.pages[0].rows[1].columns[0].blocks.find((block) => block.id === button.id);
  assert.equal(
    frontButton.zIndex,
    Math.max(
      ...listFreeLayoutItems(front.pages[0], "desktop").map((item) => item.zIndex),
    ),
  );

  const iconSelection = {
    kind: "icon",
    pageId: freePage.id,
    rowId: freePage.rows[1].id,
    columnId: freePage.rows[1].columns[0].id,
    blockId: button.id,
    iconObjectId: "detached-check",
  };
  const iconMoved = updateLayoutNodeRect(front, iconSelection, "mobile", {
    ...frontButton.detachedIcon.placement.mobile,
    x: 5.625,
  });
  const icon = listFreeLayoutItems(iconMoved.pages[0], "mobile").find(
    (item) => item.id === "detached-check",
  );
  assert.equal(icon.rect.x, 5.625);
  const iconDeleted = deleteDetachedIcon(iconMoved, iconSelection);
  const buttonAfterDelete =
    iconDeleted.pages[0].rows[1].columns[0].blocks.find((block) => block.id === button.id);
  assert.equal(buttonAfterDelete.actionId, button.actionId);
  assert.equal(buttonAfterDelete.detachedIcon, undefined);
});

test("creates and removes a detached button icon without changing its action", () => {
  const page = convertPageToFreeLayout(
    structuredClone(demoHomeLayout.pages[0]),
    () => "icon-unused",
  );
  const layout = { ...demoHomeLayout, pages: [page] };
  const row = page.rows[1];
  const column = row.columns[0];
  const button = column.blocks.find((block) => block.type === "button");
  const withIcon = setButtonIcon(
    layout,
    page,
    row.id,
    column.id,
    button.id,
    "arrow-right",
  );
  const updatedButton =
    withIcon.pages[0].rows[1].columns[0].blocks.find((block) => block.id === button.id);

  assert.equal(updatedButton.actionId, button.actionId);
  assert.equal(updatedButton.iconId, undefined);
  assert.equal(updatedButton.detachedIcon.iconId, "arrow-right");
  assert.equal(validateLayoutConfig(withIcon).valid, true);

  const removed = setButtonIcon(
    withIcon,
    withIcon.pages[0],
    row.id,
    column.id,
    button.id,
    null,
  );
  const removedButton =
    removed.pages[0].rows[1].columns[0].blocks.find((block) => block.id === button.id);
  assert.equal(removedButton.actionId, button.actionId);
  assert.equal(removedButton.detachedIcon, undefined);
});

test("reuses the canvas gesture engine for decimal movement, resize, snapping, and aspect lock", () => {
  const moveGesture = {
    itemId: "active",
    payload: "active-node",
    mode: "move",
    startPoint: { x: 10, y: 10 },
    startRect: { x: 1.25, y: 2.5, width: 40.5, height: 20.25 },
    edges: {},
    targets: [{ id: "target", rect: { x: 80, y: 10, width: 20, height: 20 } }],
  };
  const moved = updateCanvasGesture(
    moveGesture,
    { x: 13.5, y: 14.25 },
    { enabled: false, tolerance: 8, preserveAspectRatio: false },
  );
  assert.deepEqual(moved.rect, {
    x: 4.75,
    y: 6.75,
    width: 40.5,
    height: 20.25,
  });

  const resizeGesture = {
    ...moveGesture,
    mode: "resize",
    edges: { right: true, bottom: true },
    targets: [{ id: "target", rect: { x: 50, y: 10, width: 20, height: 20 } }],
  };
  const snapped = updateCanvasGesture(
    resizeGesture,
    { x: 18, y: 20 },
    { enabled: true, tolerance: 8, preserveAspectRatio: false },
  );
  assert.equal(snapped.rect.x, 1.25);
  assert.equal(snapped.rect.width, 48.75);
  assert.ok(snapped.guides.length > 0);

  const locked = updateCanvasGesture(
    resizeGesture,
    { x: 20, y: 20 },
    { enabled: false, tolerance: 8, preserveAspectRatio: true },
  );
  assert.equal(locked.rect.width / locked.rect.height, 2);

  const resizedAlignment = alignResizedCanvasRect(
    { x: 0, y: 0, width: 48, height: 20 },
    [{ id: "edge", rect: { x: 50, y: 100, width: 30, height: 20 } }],
    { enabled: true, tolerance: 4 },
    { right: true },
  );
  assert.equal(resizedAlignment.rect.x, 0);
  assert.equal(resizedAlignment.rect.width, 50);
});

test("persists responsive free geometry through the existing local repository", async () => {
  const storage = new MemoryStorage();
  const repository = new LocalStorageLayoutRepository(storage);
  const freePage = convertPageToFreeLayout(
    structuredClone(demoHomeLayout.pages[0]),
    () => "detached-check",
  );
  const freeLayout = { ...demoHomeLayout, pages: [freePage] };
  const expectedGeometry = snapshotFreeGeometry(freePage);
  const flowLayout = {
    ...freeLayout,
    pages: [{ ...freePage, layoutMode: "flow" }],
  };
  await repository.saveDraft(flowLayout);
  const restoredFlow = await repository.loadDraft(freeLayout.layoutId);
  assert.equal(restoredFlow.pages[0].layoutMode, "flow");
  assert.deepEqual(snapshotFreeGeometry(restoredFlow.pages[0]), expectedGeometry);

  const restoredPage = convertPageToFreeLayout(restoredFlow.pages[0]);
  assert.deepEqual(snapshotFreeGeometry(restoredPage), expectedGeometry);
  await repository.saveDraft({
    ...restoredFlow,
    pages: [restoredPage],
  });
  const restored = await repository.loadDraft(freeLayout.layoutId);
  assert.equal(restored.pages[0].layoutMode, "free");
  assert.deepEqual(snapshotFreeGeometry(restored.pages[0]), expectedGeometry);
  assert.equal(
    restored.pages[0].rows[1].columns[0].blocks[1].placement.mobile.y,
    freePage.rows[1].columns[0].blocks[1].placement.mobile.y,
  );
});

test("rejects free-layout objects without geometry and negative numeric spacing", () => {
  const freeLayout = structuredClone(demoHomeLayout);
  freeLayout.pages[0].layoutMode = "free";

  const invalid = validateLayoutConfig(freeLayout);
  assert.equal(invalid.valid, false);
  if (!invalid.valid) {
    assert.match(invalid.issues[0].message, /require placement and zIndex/);
  }

  const invalidSpacing = structuredClone(demoHomeLayout);
  invalidSpacing.pages[0].rows[0].spacingPx = -0.1;
  assert.equal(validateLayoutConfig(invalidSpacing).valid, false);
});

test("supports precise geometry updates without coupling responsive profiles", () => {
  const desktop = { x: 1.25, y: 2.5, width: 100.75, height: 30.125 };
  const tablet = { x: 4.5, y: 5.25, width: 80.5, height: 25.75 };
  const mobile = { x: 7.125, y: 8.25, width: 60.75, height: 20.5 };
  const placement = { desktop, tablet, mobile };
  const next = updateResponsiveCanvasRect(placement, "tablet", {
    x: -0.25,
    y: 12.125,
    width: 75.5,
    height: 22.25,
  });

  assert.deepEqual(next.desktop, desktop);
  assert.deepEqual(next.mobile, mobile);
  assert.deepEqual(next.tablet, {
    x: -0.25,
    y: 12.125,
    width: 75.5,
    height: 22.25,
  });
  assert.equal(isValidCanvasRect(next.tablet), true);
  assert.equal(isValidSpacingPx(0.125), true);
  assert.equal(isValidSpacingPx(-0.125), false);
  assert.deepEqual(
    updateCanvasRect(next.desktop, { x: 3.375 }),
    { ...desktop, x: 3.375 },
  );
  assert.deepEqual(
    resizeCanvasRect(next.desktop, { right: true, bottom: true }, 0.125, 0.25),
    { ...desktop, width: 100.875, height: 30.375 },
  );
  assert.throws(
    () => resizeCanvasRect(next.desktop, { left: true }, 200, 0),
    /Canvas rectangle values are invalid/,
  );
});

test("allows overlapping geometry and keeps snapping optional", () => {
  assert.deepEqual(defaultCanvasInteractionPreferences, {
    snapEnabled: false,
    snapTolerance: 8,
  });
  const rect = { x: 10.25, y: 10.5, width: 40.75, height: 20.25 };
  const overlappingTarget = {
    id: "target",
    rect: { x: 30.5, y: 12.25, width: 50.5, height: 20.75 },
  };
  const unsnapped = alignCanvasRect(rect, [overlappingTarget], {
    enabled: false,
    tolerance: 8,
  });

  assert.deepEqual(unsnapped.rect, rect);
  assert.ok(unsnapped.guides.length > 0);
  assert.deepEqual(
    measureCanvasRectDistance(rect, overlappingTarget.rect),
    {
      x: { gap: -20.5, overlap: 20.5 },
      y: { gap: -18.5, overlap: 18.5 },
    },
  );

  const snapped = alignCanvasRect(
    { x: 9.5, y: 11.5, width: 40, height: 20 },
    [{ id: "near", rect: { x: 10, y: 10, width: 50, height: 30 } }],
    { enabled: true, tolerance: 2 },
  );
  assert.equal(snapped.rect.x, 10);
  assert.equal(snapped.rect.y, 10);
  assert.ok(snapped.guides.length > 0);
});

test("orders layers independently of geometry and payload", () => {
  const item = (id, zIndex) => ({
    id,
    zIndex,
    payload: { retained: id },
    placement: {
      desktop: { x: 0, y: 0, width: 10, height: 10 },
      tablet: { x: 0, y: 0, width: 10, height: 10 },
      mobile: { x: 0, y: 0, width: 10, height: 10 },
    },
  });
  const items = [item("front", 5), item("back", -2), item("middle", 1)];

  const reordered = moveCanvasItemLayer(items, "back", "front");
  assert.deepEqual(
    reordered.map(({ id, zIndex }) => [id, zIndex]),
    [["middle", 0], ["front", 1], ["back", 2]],
  );
  assert.equal(reordered[0].payload.retained, "middle");
  assert.equal(items[0].zIndex, 5);
});

test("rejects duplicate node ids", () => {
  const duplicateId = structuredClone(demoHomeLayout);
  duplicateId.pages[0].rows[0].columns[0].blocks[0].id =
    duplicateId.pages[0].id;

  const result = validateLayoutConfig(duplicateId);
  assert.equal(result.valid, false);
  assert.match(result.issues[0].message, /duplicate node id/);
});

test("adds and deletes rows, columns, and registered components", () => {
  const pageId = demoHomeLayout.pages[0].id;
  let layout = addRow(demoHomeLayout, pageId);
  const row = layout.pages[0].rows[layout.pages[0].rows.length - 1];
  layout = addColumn(layout, pageId, row.id);
  const nextRow = layout.pages[0].rows[layout.pages[0].rows.length - 1];
  const column = nextRow.columns[nextRow.columns.length - 1];
  layout = addBlock(layout, pageId, nextRow.id, column.id, "card");
  const addedBlock = layout.pages[0].rows.at(-1).columns.at(-1).blocks[0];
  assert.equal(addedBlock.type, "card");
  assert.equal(validateLayoutConfig(layout).valid, true);

  layout = deleteBlock(layout, pageId, nextRow.id, column.id, addedBlock.id);
  layout = deleteColumn(layout, pageId, nextRow.id, column.id);
  assert.equal(layout.pages[0].rows.at(-1).columns.length, 1);
});

test("moves rows, columns, and components without losing layout data", () => {
  const pageId = demoHomeLayout.pages[0].id;
  const page = demoHomeLayout.pages[0];
  const [firstRow, secondRow] = page.rows;
  const sourceColumn = firstRow.columns[0];
  const targetColumn = secondRow.columns[0];
  const sourceBlock = sourceColumn.blocks[0];

  let layout = moveBlock(
    demoHomeLayout,
    pageId,
    sourceBlock.id,
    secondRow.id,
    targetColumn.id,
    targetColumn.blocks[0].id,
  );
  layout = moveColumn(
    layout,
    pageId,
    firstRow.id,
    firstRow.columns[1].id,
    secondRow.id,
    targetColumn.id,
  );
  layout = moveRow(layout, pageId, firstRow.id, secondRow.id);

  const result = validateLayoutConfig(layout);
  assert.equal(result.valid, true);
  assert.equal(layout.pages[0].rows[0].id, secondRow.id);
  assert.equal(
    layout.pages[0].rows[0].columns[1].blocks[0].id,
    sourceBlock.id,
  );
});

test("saves, publishes, exports, and restores local layout versions", async () => {
  const storage = new MemoryStorage();
  const repository = new LocalStorageLayoutRepository(storage);
  await repository.saveDraft(demoHomeLayout);
  await repository.publishDraft(demoHomeLayout.layoutId);

  const firstRevision = (await repository.listRevisions(
    demoHomeLayout.layoutId,
  ))[0];
  assert.ok(firstRevision);

  const revisedLayout = structuredClone(demoHomeLayout);
  revisedLayout.pages[0].rows[0].columns[0].blocks[0].text =
    "Version de démonstration modifiée";
  await repository.saveDraft(revisedLayout);
  await repository.publishDraft(revisedLayout.layoutId);

  const backup = await repository.exportLayout(
    revisedLayout.layoutId,
    "published",
  );
  assert.equal(typeof backup, "string");

  await repository.restoreRevision(
    revisedLayout.layoutId,
    firstRevision.revisionId,
  );
  assert.deepEqual(
    await repository.loadDraft(revisedLayout.layoutId),
    demoHomeLayout,
  );

  const importedRepository = new LocalStorageLayoutRepository(
    new MemoryStorage(),
  );
  await importedRepository.importDraft(backup);
  assert.deepEqual(
    await importedRepository.loadDraft(revisedLayout.layoutId),
    revisedLayout,
  );
});

test("reports corrupt local records and malformed backups", async () => {
  const storage = new MemoryStorage();
  storage.setItem(
    "bonobos.layout.repository.v1:demo-home",
    "{not valid json",
  );
  const repository = new LocalStorageLayoutRepository(storage);

  await assert.rejects(
    () => repository.loadDraft("demo-home"),
    /not valid JSON/,
  );
  await assert.rejects(
    () => repository.importDraft("{"),
    /not valid JSON/,
  );
});

test("supports undo and redo for immutable layout snapshots", () => {
  const first = { version: 1 };
  const second = { version: 2 };
  const third = { version: 3 };

  const history = commitHistory(
    commitHistory(createHistory(first), second),
    third,
  );
  const undone = undoHistory(history);
  assert.deepEqual(undone.present, second);

  const redone = redoHistory(undone);
  assert.deepEqual(redone.present, third);
  assert.equal(redoHistory(redone), redone);
});
