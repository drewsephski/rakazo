import { Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import { Children, isValidElement, memo, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";
import type { ExtractedTable, HastNode, TableAlign, TableSortDirection } from "./table-utils";
import {
  columnMinWidths,
  extractTable,
  isNumericColumn,
  nextSort,
  sortRows,
  TABLE_PAGE_SIZE,
  tableToCsv,
  tableToTsv,
} from "./table-utils";

/**
 * Renders a GFM markdown table as an interactive data card. Extracted plain
 * text drives sorting and export while sanitized React children preserve
 * inline markup in headers and cells. Invalid tables fall back to the default
 * <table>.
 */
export const MarkdownTable = memo(function MarkdownTable({
  node,
  tableProps,
  children,
}: {
  node?: HastNode;
  tableProps?: ComponentPropsWithoutRef<"table">;
  children?: ReactNode;
}) {
  const extracted = useMemo(() => extractTable(node), [node]);
  const rendered = useMemo(() => extractRenderedCells(children), [children]);
  if (!extracted) return <table {...tableProps}>{children}</table>;
  return (
    <TableCard table={extracted} renderedHeaders={rendered.headers} renderedRows={rendered.rows} />
  );
});

type SortState = { column: number; direction: TableSortDirection } | null;

export const TableCard = memo(function TableCard({
  table,
  renderedHeaders,
  renderedRows,
}: {
  table: ExtractedTable;
  renderedHeaders?: ReactNode[];
  renderedRows?: ReactNode[][];
}) {
  const { columns, aligns, rows } = table;
  const schemaKey = JSON.stringify([columns, aligns]);
  const [sort, setSort] = useState<SortState>(null);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [copiedSignature, setCopiedSignature] = useState<string | null>(null);
  const copiedTimer = useRef<number | undefined>(undefined);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const dataSignature = JSON.stringify([columns, rows]);
  const copied = copiedSignature === dataSignature;

  const numericColumns = useMemo(() => {
    const numeric = new Set<number>();
    columns.forEach((_, i) => {
      if (isNumericColumn(rows, i)) numeric.add(i);
    });
    return numeric;
  }, [columns, rows]);

  const minWidths = useMemo(() => columnMinWidths(columns, rows), [columns, rows]);
  const rowKeys = useMemo(() => {
    const occurrences = new Map<string, number>();
    return new Map(
      rows.map((row) => {
        const signature = JSON.stringify(row);
        const occurrence = occurrences.get(signature) ?? 0;
        occurrences.set(signature, occurrence + 1);
        return [row, `${signature}:${occurrence}`] as const;
      }),
    );
  }, [rows]);
  const renderedRowsBySource = useMemo(
    () => new Map(rows.map((row, index) => [row, renderedRows?.[index]])),
    [renderedRows, rows],
  );
  const sortedRows = useMemo(
    () => (sort ? sortRows(rows, sort.column, sort.direction) : rows),
    [rows, sort],
  );

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / TABLE_PAGE_SIZE));
  const showPagination = sortedRows.length > TABLE_PAGE_SIZE;
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = showPagination
    ? sortedRows.slice(safePage * TABLE_PAGE_SIZE, (safePage + 1) * TABLE_PAGE_SIZE)
    : sortedRows;

  // Data and sort changes only clamp the page; an explicit sort click resets
  // to page 0 in the handler so the two coalesce into one commit.
  useEffect(() => setPage((p) => Math.min(p, pageCount - 1)), [pageCount]);
  useEffect(() => {
    setSort(null);
    setPage(0);
    setExpanded(false);
  }, [schemaKey]);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const toggleSort = (column: number) => {
    setSort((current) => nextSort(current, column));
    setPage(0);
  };

  const copyRows = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard
      .writeText(tableToTsv(columns, sortedRows))
      .then(() => {
        setCopiedSignature(dataSignature);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopiedSignature(null), 1500);
      })
      .catch(() => {});
  };

  const downloadCsv = () => {
    // BOM so spreadsheet apps decode UTF-8 correctly.
    const blob = new Blob([`\uFEFF${tableToCsv(columns, sortedRows)}`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "table.csv";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const tableView = (mode: "card" | "dialog") => (
    <TableView
      columns={columns}
      aligns={aligns}
      rows={pageRows}
      rowOffset={safePage * TABLE_PAGE_SIZE}
      numericColumns={numericColumns}
      minWidths={minWidths}
      renderedHeaders={renderedHeaders}
      renderedRows={renderedRowsBySource}
      rowKeys={rowKeys}
      expanded={mode === "dialog"}
      sort={sort}
      onToggleSort={toggleSort}
    />
  );

  const pager = showPagination ? (
    <div className="rk-table-footer">
      <span className="rk-table-range">
        {safePage * TABLE_PAGE_SIZE + 1}–
        {Math.min((safePage + 1) * TABLE_PAGE_SIZE, sortedRows.length)} of {sortedRows.length} rows
      </span>
      <button
        type="button"
        className="rk-table-tool"
        aria-label="Previous page"
        disabled={safePage === 0}
        onClick={() => setPage(safePage - 1)}
      >
        <ChevronLeftIcon />
      </button>
      <button
        type="button"
        className="rk-table-tool"
        aria-label="Next page"
        disabled={safePage >= pageCount - 1}
        onClick={() => setPage(safePage + 1)}
      >
        <ChevronRightIcon />
      </button>
    </div>
  ) : (
    <div className="rk-table-footer">
      <span className="rk-table-range">
        {sortedRows.length} {sortedRows.length === 1 ? "row" : "rows"}
      </span>
    </div>
  );

  const tools = (mode: "card" | "dialog") => (
    <div className="rk-table-head">
      <button
        type="button"
        className="rk-table-tool"
        onClick={copyRows}
        aria-label={copied ? "Copied" : "Copy rows"}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <button
        type="button"
        className="rk-table-tool"
        onClick={downloadCsv}
        aria-label="Download CSV"
      >
        <DownloadIcon />
      </button>
      {mode === "card" ? (
        <button
          type="button"
          className="rk-table-tool"
          ref={expandButtonRef}
          onClick={() => setExpanded(true)}
          aria-label="Expand table"
        >
          <ExpandIcon />
        </button>
      ) : (
        <DialogClose
          ref={closeButtonRef}
          aria-label="Close table"
          render={<button type="button" className="rk-table-tool" />}
        >
          <CloseIcon />
        </DialogClose>
      )}
    </div>
  );

  return (
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <div className="rk-table-card rk-table-box" data-testid="table-card">
        {tools("card")}
        <div className="rk-table-scroll">{tableView("card")}</div>
        {pager}
      </div>
      <DialogContent
        showCloseButton={false}
        initialFocus={closeButtonRef}
        finalFocus={expandButtonRef}
        className="rk-table-dialog rk-table-box rk-chat-markdown"
      >
        <DialogTitle className="rk-table-dialog-title">Table</DialogTitle>
        {tools("dialog")}
        <div className="rk-table-scroll rk-table-dialog-scroll">{tableView("dialog")}</div>
        {pager}
      </DialogContent>
    </Dialog>
  );
});

function TableView({
  columns,
  aligns,
  rows,
  rowOffset,
  numericColumns,
  minWidths,
  renderedHeaders,
  renderedRows,
  rowKeys,
  expanded,
  sort,
  onToggleSort,
}: {
  columns: string[];
  aligns: TableAlign[];
  rows: string[][];
  rowOffset: number;
  numericColumns: Set<number>;
  minWidths: Record<number, string>;
  renderedHeaders?: ReactNode[];
  renderedRows: Map<string[], ReactNode[] | undefined>;
  rowKeys: Map<string[], string>;
  expanded: boolean;
  sort: SortState;
  onToggleSort: (column: number) => void;
}) {
  // Numeric columns right-align unless the author declared an alignment.
  const alignClass = (index: number) => {
    const align = aligns[index] ?? (numericColumns.has(index) ? "right" : "left");
    return align && align !== "left" ? `rk-align-${align}` : undefined;
  };
  return (
    <table className="rk-table" aria-label="Markdown table">
      <thead>
        <tr>
          <th className="rk-table-gutter" scope="col" aria-label="Row" />
          {columns.map((column, i) => (
            <SortableColumnHeader
              key={i}
              column={column}
              content={renderedHeaders?.[i] ?? column}
              direction={sort?.column === i ? sort.direction : null}
              className={alignClass(i)}
              onToggleSort={() => onToggleSort(i)}
            />
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length + 1} className="rk-table-empty">
              No rows
            </td>
          </tr>
        ) : (
          rows.map((row, rowIndex) => (
            <tr key={rowKeys.get(row)}>
              <td className="rk-table-gutter">{rowOffset + rowIndex + 1}</td>
              {columns.map((_, columnIndex) => {
                const value = row[columnIndex] ?? "";
                return (
                  <td
                    key={columnIndex}
                    style={{ minWidth: expanded ? undefined : minWidths[columnIndex] }}
                    className={alignClass(columnIndex)}
                  >
                    <span
                      className="rk-table-cell-text"
                      title={!expanded && value ? value : undefined}
                    >
                      {renderedRows.get(row)?.[columnIndex] ?? value}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function SortableColumnHeader({
  column,
  content,
  direction,
  className,
  onToggleSort,
}: {
  column: string;
  content: ReactNode;
  direction: TableSortDirection | null;
  className?: string;
  onToggleSort: () => void;
}) {
  const rich = !isPlainText(content);
  const sortButton = (
    <button
      type="button"
      className={rich ? "rk-table-sort-trigger" : "rk-table-sort"}
      onClick={onToggleSort}
      aria-label={`Sort by ${column}`}
    >
      {rich ? null : <span className="rk-table-sort-label">{content}</span>}
      <SortIndicator direction={direction} />
    </button>
  );
  return (
    <th
      aria-sort={direction ? (direction === "asc" ? "ascending" : "descending") : undefined}
      className={className}
      scope="col"
    >
      {rich ? (
        <div className="rk-table-sort">
          <span className="rk-table-sort-label">{content}</span>
          {sortButton}
        </div>
      ) : (
        sortButton
      )}
    </th>
  );
}

function isPlainText(node: ReactNode): boolean {
  return Children.toArray(node).every(
    (child) => typeof child === "string" || typeof child === "number",
  );
}

type ElementWithChildren = ReactElement<{ children?: ReactNode }>;

function extractRenderedCells(children: ReactNode): {
  headers?: ReactNode[];
  rows?: ReactNode[][];
} {
  const rows: ElementWithChildren[] = [];
  const collect = (node: ReactNode) => {
    for (const child of Children.toArray(node)) {
      if (!isValidElement<{ children?: ReactNode }>(child)) continue;
      if (child.type === "tr") rows.push(child);
      else collect(child.props.children);
    }
  };
  collect(children);

  const [headerRow, ...bodyRows] = rows;
  const headerTh = headerRow ? cellChildren(headerRow, "th") : [];
  const headerCells =
    headerTh.length > 0 ? headerTh : headerRow ? cellChildren(headerRow, "td") : [];
  const renderedBody = bodyRows.map((row) => {
    const cells = cellChildren(row, "td");
    return cells.length > 0 ? cells : cellChildren(row, "th");
  });
  return {
    headers: headerCells.length > 0 ? headerCells : undefined,
    rows: renderedBody.length > 0 ? renderedBody : undefined,
  };
}

function cellChildren(row: ElementWithChildren, type: "th" | "td"): ReactNode[] {
  return Children.toArray(row.props.children)
    .filter(
      (cell): cell is ElementWithChildren =>
        isValidElement<{ children?: ReactNode }>(cell) && cell.type === type,
    )
    .map((cell) => cell.props.children);
}

function SortIndicator({ direction }: { direction: TableSortDirection | null }) {
  return (
    <span className="rk-table-sort-icon" aria-hidden="true">
      <ChevronUpIcon active={direction === "asc"} />
      <ChevronDownIcon active={direction === "desc"} />
    </span>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 4v11m0 0 4-4m-4 4-4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 17v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3m0 8v3a2 2 0 0 0 2 2h-3M3 16v3a2 2 0 0 0 2 2h3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ChevronUpIcon({ active = false }: { active?: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={active ? "rk-sort-on" : "rk-sort-off"}
    >
      <path
        d="m6 15 6-6 6 6"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDownIcon({ active = false }: { active?: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={active ? "rk-sort-on" : "rk-sort-off"}
    >
      <path
        d="m6 9 6 6 6-6"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m14 7-5 5 5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m10 7 5 5-5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
