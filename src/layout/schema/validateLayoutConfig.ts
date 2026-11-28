import Ajv, { type ErrorObject } from "ajv";
import layoutV1Schema from "./layout-v1.schema.json" with { type: "json" };
import layoutV2Schema from "./layout-v2.schema.json" with { type: "json" };
import layoutV3Schema from "./layout-v3.schema.json" with { type: "json" };
import {
  migrateLayoutV1ToV2,
  migrateLayoutV2ToV3,
} from "./migrations.ts";
import type {
  LayoutConfig,
  LayoutConfigV1,
  LayoutConfigV2,
} from "./types.ts";

export interface LayoutValidationIssue {
  path: string;
  message: string;
}

export type LayoutValidationResult =
  | { valid: true; value: LayoutConfig }
  | { valid: false; issues: LayoutValidationIssue[] };

const ajv = new Ajv({ allErrors: true, strict: true });

let validateV1: any = null;
let validateV2: any = null;
let validateV3: any = null;

function getValidators(): {
  validateV1: any;
  validateV2: any;
  validateV3: any;
} {
  if (validateV1 === null) {
    validateV1 = ajv.compile<LayoutConfigV1>(layoutV1Schema);
  }
  if (validateV2 === null) {
    validateV2 = ajv.compile<LayoutConfigV2>(layoutV2Schema);
  }
  if (validateV3 === null) {
    validateV3 = ajv.compile<LayoutConfig>(layoutV3Schema);
  }
  return { validateV1, validateV2, validateV3 };
}

function formatAjvIssue(error: ErrorObject): LayoutValidationIssue {
  return {
    path: error.instancePath || "/",
    message: error.message ?? "does not match the layout schema",
  };
}

function collectSemanticIssues(layout: LayoutConfig): LayoutValidationIssue[] {
  const issues: LayoutValidationIssue[] = [];
  const nodeIds = new Set<string>();
  const pageOrders = new Set<number>();
  const requireFreePlacement = (
    node: { placement?: unknown; zIndex?: unknown },
    path: string,
  ) => {
    if (node.placement === undefined || node.zIndex === undefined) {
      issues.push({
        path,
        message: "free-layout nodes require placement and zIndex",
      });
    }
  };

  const registerId = (id: string, path: string) => {
    if (nodeIds.has(id)) {
      issues.push({ path, message: `duplicate node id "${id}"` });
      return;
    }
    nodeIds.add(id);
  };

  layout.pages.forEach((page, pageIndex) => {
    registerId(page.id, `/pages/${pageIndex}/id`);

    if (pageOrders.has(page.order)) {
      issues.push({
        path: `/pages/${pageIndex}/order`,
        message: `duplicate page order "${page.order}"`,
      });
    }
    pageOrders.add(page.order);

    page.rows.forEach((row, rowIndex) => {
      registerId(row.id, `/pages/${pageIndex}/rows/${rowIndex}/id`);
      if (page.layoutMode === "free") {
        requireFreePlacement(row, `/pages/${pageIndex}/rows/${rowIndex}`);
      } else if (row.columns.length > 12) {
        issues.push({
          path: `/pages/${pageIndex}/rows/${rowIndex}/columns`,
          message: "flow-layout rows cannot contain more than 12 columns",
        });
      }

      row.columns.forEach((column, columnIndex) => {
        const columnPath =
          `/pages/${pageIndex}/rows/${rowIndex}/columns/${columnIndex}`;
        registerId(
          column.id,
          `${columnPath}/id`,
        );
        if (page.layoutMode === "free") {
          requireFreePlacement(column, columnPath);
        } else if (column.span === undefined) {
          issues.push({
            path: `${columnPath}/span`,
            message: "flow-layout columns require responsive grid spans",
          });
        }

        column.blocks.forEach((block, blockIndex) => {
          const blockPath = `${columnPath}/blocks/${blockIndex}`;
          registerId(
            block.id,
            `${blockPath}/id`,
          );
          if (page.layoutMode === "free") {
            requireFreePlacement(block, blockPath);
          }
          if (block.type === "button" && block.detachedIcon !== undefined) {
            registerId(block.detachedIcon.id, `${blockPath}/detachedIcon/id`);
          }
          if (
            page.layoutMode === "free" &&
            block.type === "button" &&
            block.iconId !== undefined &&
            block.detachedIcon === undefined
          ) {
            issues.push({
              path: `${blockPath}/iconId`,
              message: "free-layout icons require an independent icon object",
            });
          }
          if (
            page.layoutMode === "free" &&
            block.type === "button" &&
            block.iconId !== undefined &&
            block.detachedIcon !== undefined
          ) {
            issues.push({
              path: `${blockPath}/iconId`,
              message:
                "free-layout buttons cannot combine inline and independent icons",
            });
          }
        });
      });
    });
  });

  return issues;
}

function validateLatestLayout(layout: LayoutConfig): LayoutValidationResult {
  const semanticIssues = collectSemanticIssues(layout);
  if (semanticIssues.length > 0) {
    return {
      valid: false,
      issues: semanticIssues,
    };
  }

  return { valid: true, value: layout };
}

export function validateLayoutConfig(value: unknown): LayoutValidationResult {
  const { validateV1, validateV2, validateV3 } = getValidators();
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 1
  ) {
    if (!validateV1(value)) {
      return {
        valid: false,
        issues: (validateV1.errors ?? []).map(formatAjvIssue),
      };
    }

    return validateLatestLayout(
      migrateLayoutV2ToV3(migrateLayoutV1ToV2(value as LayoutConfigV1)),
    );
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 2
  ) {
    if (!validateV2(value)) {
      return {
        valid: false,
        issues: (validateV2.errors ?? []).map(formatAjvIssue),
      };
    }
    return validateLatestLayout(migrateLayoutV2ToV3(value as LayoutConfigV2));
  }

  if (!validateV3(value)) {
    return {
      valid: false,
      issues: (validateV3.errors ?? []).map(formatAjvIssue),
    };
  }

  return validateLatestLayout(value as LayoutConfig);
}

export class LayoutConfigValidationError extends Error {
  readonly issues: LayoutValidationIssue[];

  constructor(issues: LayoutValidationIssue[]) {
    super(issues.map(({ path, message }) => `${path}: ${message}`).join("\n"));
    this.name = "LayoutConfigValidationError";
    this.issues = issues;
  }
}

export function parseLayoutConfig(value: unknown): LayoutConfig {
  const result = validateLayoutConfig(value);
  if (!result.valid) {
    throw new LayoutConfigValidationError(result.issues);
  }

  return result.value;
}
