/**
 * Owns the compound episode-tag format `"<type>,<project>"`.
 *
 * Structured `memory` episodes pack their entry type and project scope into the
 * single `tags` column. This module is the one place that knows that format:
 * it encodes the tag on write and produces the SQL fragment that matches a
 * project's rows on read. Callers never rebuild the comma/`LIKE` shape by hand.
 */

export function encodeProjectTag(type: string, project: string): string {
  return [type, project].join(",");
}

export interface ProjectMatch {
  clause: string;
  params: string[];
}

/**
 * Build the SQL fragment (and its params) that restricts a query to one
 * project's rows against the packed `tags` column. When `project` is undefined
 * the match is a no-op (`{ clause: "", params: [] }`), so callers keep their
 * optional-project behaviour without writing their own conditional.
 *
 * `column` names the table/alias the `tags` column lives on (e.g. `"e"` for the
 * aliased FTS join). Defaults to the bare `tags` column.
 */
export function projectMatchClause(
  project: string | undefined,
  column = "",
  includeNeutral = false,
): ProjectMatch {
  if (!project) return { clause: "", params: [] };
  const col = column ? `${column}.tags` : "tags";
  const src = column ? `${column}.source` : "source";
  const projectCondition = `(${col} = ? OR ${col} LIKE ? OR ${col} LIKE ? OR ${col} LIKE ?)`;
  const projectParams = [project, `${project},%`, `%,${project}`, `%,${project},%`];

  if (includeNeutral) {
    return {
      clause: `AND (${src} = 'skill' OR ${src} = 'consolidation' OR ${col} LIKE '%,__global__' OR ${col} = '__global__' OR (${col} NOT LIKE '%,/%' AND ${col} NOT LIKE '%,\\%' AND ${col} NOT LIKE '%,_:%') OR ${projectCondition})`,
      params: projectParams,
    };
  }
  return {
    clause: `AND ${projectCondition}`,
    params: projectParams,
  };
}
