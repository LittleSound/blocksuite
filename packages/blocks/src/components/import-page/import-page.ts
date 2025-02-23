import '../loader.js';

import { assertExists } from '@blocksuite/global/utils';
import { WithDisposable } from '@blocksuite/lit';
import { type Workspace } from '@blocksuite/store';
import JSZip from 'jszip';
import { html, LitElement, type PropertyValues } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import { ContentParser } from '../../__internal__/content-parser/index.js';
import type { SerializedBlock } from '../../__internal__/utils/index.js';
import { createPage, openFileOrFiles } from '../../__internal__/utils/index.js';
import { columnManager } from '../../database-block/common/columns/manager.js';
import { richTextPureColumnConfig } from '../../database-block/common/columns/rich-text/define.js';
import {
  CloseIcon,
  ExportToHTMLIcon,
  ExportToMarkdownIcon,
  HelpIcon,
  NewIcon,
  NotionIcon,
} from '../../icons/index.js';
import type { Cell, Column } from '../../index.js';
import { styles } from './styles.js';

export type OnSuccessHandler = (
  pageIds: string[],
  isWorkspaceFile: boolean
) => void;

const SHOW_LOADING_SIZE = 1024 * 200;

export async function importMarkDown(workspace: Workspace, text: string) {
  const page = await createPage(workspace);
  const rootId = page.root?.id;
  assertExists(
    rootId,
    `Failed to import markdown, page root not found! pageId: ${page.id}`
  );
  const contentParser = new ContentParser(page);
  await contentParser.importMarkdown(text, rootId);
  return [page.id];
}

export async function importHtml(workspace: Workspace, text: string) {
  const page = await createPage(workspace);
  const rootId = page.root?.id;
  assertExists(
    rootId,
    `Failed to import HTML, page root not found! pageId: ${page.id}`
  );
  const contentParser = new ContentParser(page);
  await contentParser.importHtml(text, rootId);
  return [page.id];
}

function joinWebPaths(...paths: string[]): string {
  const fullPath = paths.join('/').replace(/\/+/g, '/');
  const parts = fullPath.split('/').filter(Boolean);

  const resolvedParts: string[] = [];

  parts.forEach(part => {
    if (part === '.') {
      return;
    }

    if (part === '..') {
      resolvedParts.pop();
    } else {
      resolvedParts.push(part);
    }
  });

  return resolvedParts.join('/');
}

export async function importNotion(workspace: Workspace, file: File) {
  const pageIds: string[] = [];
  // const allPageMap: Map<string, Page>[] = [];
  // const dataBaseSubPages = new Set<string>();
  let isWorkspaceFile = false;
  const parseZipFile = async (file: File | Blob) => {
    const zip = new JSZip();
    const zipFile = await zip.loadAsync(file);
    const pageMap = new Map<string, string>();
    // allPageMap.push(pageMap);
    const files = Object.keys(zipFile.files);
    const promises: Promise<void>[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.startsWith('__MACOSX/')) continue;

      const lastSplitIndex = file.lastIndexOf('/');

      const fileName = file.substring(lastSplitIndex + 1);
      if (fileName.endsWith('.html') || fileName.endsWith('.md')) {
        if (file.endsWith('/index.html')) {
          isWorkspaceFile = true;
          continue;
        }
        if (lastSplitIndex !== -1) {
          const text = await zipFile.files[file].async('text');
          const doc = new DOMParser().parseFromString(text, 'text/html');
          const pageBody = doc.querySelector('.page-body');
          if (pageBody && pageBody.children.length == 0) {
            continue;
          }
        }
        pageMap.set(file, workspace.idGenerator());
      }
      if (i === 0 && fileName.endsWith('.csv')) {
        pageMap.set(file, workspace.idGenerator());
      }
      if (fileName.endsWith('.zip')) {
        const innerZipFile = await zipFile.file(fileName)?.async('blob');
        if (innerZipFile) {
          promises.push(...(await parseZipFile(innerZipFile)));
        }
      }
    }
    const pagePromises = Array.from(pageMap.keys()).map(async file => {
      const page = await createPage(workspace, { id: pageMap.get(file) });
      if (!page) return;
      const lastSplitIndex = file.lastIndexOf('/');
      const folder = file.substring(0, lastSplitIndex) || '';
      const fileName = file.substring(lastSplitIndex + 1);
      if (
        fileName.endsWith('.html') ||
        fileName.endsWith('.md') ||
        fileName.endsWith('.csv')
      ) {
        const isHtml = fileName.endsWith('.html');
        const rootId = page.root?.id;
        const fetchFileHandler = async (url: string) => {
          const fileName = joinWebPaths(folder, decodeURI(url));
          return (await zipFile.file(fileName)?.async('blob')) || new Blob();
        };
        const textStyleHandler = (
          _element: HTMLElement,
          textStyle: Record<string, unknown>
        ) => {
          if (textStyle['link']) {
            const link = textStyle['link'] as string;
            const subPageLink = joinWebPaths(folder, decodeURI(link));
            const linkPageId = pageMap.get(subPageLink);
            if (linkPageId) {
              textStyle['reference'] = {
                pageId: linkPageId,
                type: 'LinkedPage',
              };
              delete textStyle['link'];
            }
          }
        };

        const csvParseHandler = async (
          tableString: string,
          titleText: string
        ) => {
          let result: SerializedBlock[] | null = [];
          let id = 1;
          const titles: string[] = [];
          const rows: string[][] = [];
          tableString?.split(/\r\n|\r|\n/).forEach((row, index) => {
            const rowArray = row.split(/,\s*(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            for (let i = 0; i < rowArray.length; i++) {
              rowArray[i] = rowArray[i].replace(/^"|"$/g, '');
            }
            if (index === 0) {
              titles.push(...rowArray);
            } else {
              rows.push(rowArray);
            }
          });

          const columns: Column[] = titles.map(value => {
            return columnManager
              .getColumn(richTextPureColumnConfig.type)
              .createWithId('' + id++, value);
          });
          if (rows.length > 0) {
            let maxLen = rows[0].length;
            for (let i = 1; i < rows.length; i++) {
              maxLen = Math.max(maxLen, rows[i].length);
            }
            const addNum = maxLen - columns.length;
            for (let i = 0; i < addNum; i++) {
              columns.push(
                columnManager
                  .getColumn(richTextPureColumnConfig.type)
                  .createWithId('' + id++, '')
              );
            }
          }

          if (columns.length === 0 || rows.length === 0) {
            return [];
          }

          let titleIndex = 0;
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            let count = 0;
            let index = 0;
            for (let j = 0; j < row.length; j++) {
              const value = row[j];
              if (files.find(file => file.includes(value))) {
                index = j;
                count++;
                if (count > 1) {
                  break;
                }
              }
            }
            if (count === 1) {
              titleIndex = index;
              break;
            }
          }
          titleIndex = titleIndex < columns.length ? titleIndex : 0;
          columns[titleIndex].type = 'title';

          const databasePropsId = id++;
          const cells: Record<string, Record<string, Cell>> = {};
          const children: SerializedBlock[] = [];
          rows.forEach(row => {
            children.push({
              flavour: 'affine:paragraph',
              type: 'text',
              text: [{ insert: row[titleIndex] }],
              children: [],
            });
            const rowId = '' + id++;
            cells[rowId] = {};
            row.forEach((value, index) => {
              cells[rowId][columns[index].id] = {
                columnId: columns[index].id,
                value,
              };
            });
          });
          result = [
            {
              flavour: 'affine:database',
              databaseProps: {
                id: '' + databasePropsId,
                title: titleText || 'Database',
                rowIds: Object.keys(cells),
                cells: cells,
                columns: columns,
                views: [
                  {
                    id: page.generateId(),
                    name: 'Table View',
                    mode: 'table',
                    columns: [],
                    header: {
                      titleColumn: columns[titleIndex].id,
                      iconColumn: 'type',
                    },
                    filter: {
                      type: 'group',
                      op: 'and',
                      conditions: [],
                    },
                  },
                ],
              },
              children: children,
            },
          ];
          return result;
        };

        const tableParseHandler = async (element: Element) => {
          // if (element.tagName === 'TABLE') {
          //   const parentElement = element.parentElement;
          //   if (
          //     parentElement?.tagName === 'DIV' &&
          //     parentElement.hasAttribute('id')
          //   ) {
          //     parentElement.id && dataBaseSubPages.add(parentElement.id);
          //   }
          //   const tbodyElement = element.querySelector('tbody');
          //   tbodyElement?.querySelectorAll('tr').forEach(ele => {
          //     ele.id && dataBaseSubPages.add(ele.id);
          //   });
          // }
          if (
            element.tagName === 'A' &&
            element.getAttribute('href')?.endsWith('.csv')
          ) {
            const href = element.getAttribute('href') || '';
            const fileName = joinWebPaths(folder, decodeURI(href));
            const tableString = await zipFile.file(fileName)?.async('string');
            const result = await csvParseHandler(
              tableString ?? '',
              element.textContent || ''
            );
            return result;
          }
          return null;
        };
        const tableTitleColumnHandler = async (element: Element) => {
          if (element.tagName === 'TABLE') {
            const titleColumn: string[] = [];
            element.querySelectorAll('.cell-title').forEach(ele => {
              const link = ele.querySelector('a');
              const subPageLink = link?.getAttribute('href') || '';
              if (
                subPageLink.startsWith('http://') ||
                subPageLink.startsWith('https://')
              ) {
                titleColumn.push(ele.textContent || '');
                return;
              }
              const linkPageId = pageMap.get(decodeURI(subPageLink));
              if (linkPageId) {
                titleColumn.push(`@AffineReference:(${linkPageId})`);
              } else {
                titleColumn.push(link?.textContent || '');
              }
            });
            return titleColumn;
          }
          return null;
        };
        const contentParser = new ContentParser(page, {
          fetchFileHandler,
          textStyleHandler,
          tableParseHandler,
          tableTitleColumnHandler,
        });
        const text = (await zipFile.file(file)?.async('string')) || '';
        if (rootId) {
          pageIds.push(page.id);
          if (fileName.endsWith('.csv')) {
            const lastSpace = fileName.lastIndexOf(' ');
            const csvName =
              lastSpace === -1 ? '' : fileName.substring(0, lastSpace);
            const csvRealName = csvName === 'Undefined' ? '' : csvName;
            const blocks = await csvParseHandler(text, csvRealName);
            if (blocks) {
              await contentParser.importBlocks(blocks, rootId);
            }
          } else if (isHtml) {
            await contentParser.importHtml(text, rootId);
          } else {
            await contentParser.importMarkdown(text, rootId);
          }
        }
      }
    });
    promises.push(...pagePromises);
    return promises;
  };
  const allPromises = await parseZipFile(file);
  await Promise.all(allPromises.flat());
  // dataBaseSubPages.forEach(notionId => {
  //   const dbSubPageId = notionId.replace(/-/g, '');
  //   allPageMap.forEach(pageMap => {
  //     for (const [key, value] of pageMap) {
  //       if (
  //         key.endsWith(` ${dbSubPageId}.html`) ||
  //         key.endsWith(` ${dbSubPageId}.md`)
  //       ) {
  //         pageIds = pageIds.filter(id => id !== value.id);
  //         this.workspace.removePage(value.id);
  //         break;
  //       }
  //     }
  //   });
  // });
  return { pageIds, isWorkspaceFile };
}

/**
 * @deprecated Waiting for migration
 * See https://github.com/toeverything/blocksuite/issues/3316
 */
@customElement('import-page')
export class ImportPage extends WithDisposable(LitElement) {
  static override styles = styles;

  @state()
  _loading = false;

  @state()
  x = 0;

  @state()
  y = 0;

  @state()
  _startX = 0;

  @state()
  _startY = 0;

  constructor(
    private workspace: Workspace,
    private onSuccess?: OnSuccessHandler,
    private abortController = new AbortController()
  ) {
    super();

    this._loading = false;

    this.x = 0;
    this.y = 0;
    this._startX = 0;
    this._startY = 0;

    this._onMouseMove = this._onMouseMove.bind(this);
  }

  loading(): boolean {
    return this._loading;
  }

  override updated(changedProps: PropertyValues) {
    if (changedProps.has('x') || changedProps.has('y')) {
      this.style.transform = `translate(${this.x}px, ${this.y}px)`;
    }
  }

  private _onMouseDown(event: MouseEvent) {
    this._startX = event.clientX - this.x;
    this._startY = event.clientY - this.y;
    window.addEventListener('mousemove', this._onMouseMove);
  }

  private _onMouseUp() {
    window.removeEventListener('mousemove', this._onMouseMove);
  }

  private _onMouseMove(event: MouseEvent) {
    this.x = event.clientX - this._startX;
    this.y = event.clientY - this._startY;
  }

  private _onCloseClick(event: MouseEvent) {
    event.stopPropagation();
    this.abortController.abort();
  }

  private _onImportSuccess(pageIds: string[], isWorkspaceFile = false) {
    this.onSuccess?.(pageIds, isWorkspaceFile);
  }

  private async _importMarkDown() {
    const file = await openFileOrFiles({ acceptType: 'Markdown' });
    if (!file) return;
    const text = await file.text();
    const needLoading = file.size > SHOW_LOADING_SIZE;
    if (needLoading) {
      this.hidden = false;
      this._loading = true;
    } else {
      this.abortController.abort();
    }
    const pageIds = await importMarkDown(this.workspace, text);
    needLoading && this.abortController.abort();
    this._onImportSuccess(pageIds);
  }

  private async _importHtml() {
    const file = await openFileOrFiles({ acceptType: 'Html' });
    if (!file) return;
    const text = await file.text();
    const needLoading = file.size > SHOW_LOADING_SIZE;
    if (needLoading) {
      this.hidden = false;
      this._loading = true;
    } else {
      this.abortController.abort();
    }
    const pageIds = await importHtml(this.workspace, text);
    needLoading && this.abortController.abort();
    this._onImportSuccess(pageIds);
  }

  private async _importNotion() {
    const file = await openFileOrFiles({ acceptType: 'Zip' });
    if (!file) return;
    // Calc size
    let totalSize = 0;
    const zip = new JSZip();
    const zipFile = await zip.loadAsync(file);
    const fileArray = Object.values(zipFile.files);
    for (const file of fileArray) {
      if (file.dir) continue;
      const fileContent = await file.async('uint8array');
      totalSize += fileContent.length;
    }
    const needLoading = totalSize > SHOW_LOADING_SIZE;
    if (needLoading) {
      this.hidden = false;
      this._loading = true;
    } else {
      this.abortController.abort();
    }
    const { pageIds, isWorkspaceFile } = await importNotion(
      this.workspace,
      file
    );
    needLoading && this.abortController.abort();
    this._onImportSuccess(pageIds, isWorkspaceFile);
  }

  private _openLearnImportLink(event: MouseEvent) {
    event.stopPropagation();
    window.open(
      'https://affine.pro/blog/import-your-data-from-notion-into-affine',
      '_blank'
    );
  }

  override render() {
    if (this._loading) {
      return html`
        <header
          class="loading-header"
          @mousedown="${this._onMouseDown}"
          @mouseup="${this._onMouseUp}"
        >
          <div>Import</div>
          <loader-element width="50px"></loader-element>
        </header>
        <div>
          Importing the file may take some time. It depends on document size and
          complexity.
        </div>
      `;
    }
    return html`
      <header @mousedown="${this._onMouseDown}" @mouseup="${this._onMouseUp}">
        <icon-button height="28px" @click="${this._onCloseClick}">
          ${CloseIcon}
        </icon-button>
        <div>Import</div>
      </header>
      <div>
        AFFiNE will gradually support more file formats for import.
        <a
          href="https://community.affine.pro/c/feature-requests/import-export"
          target="_blank"
          >Provide feedback.</a
        >
      </div>
      <div class="button-container">
        <icon-button
          class="button-item"
          text="Markdown"
          @click="${this._importMarkDown}"
        >
          ${ExportToMarkdownIcon}
        </icon-button>
        <icon-button
          class="button-item"
          text="HTML"
          @click="${this._importHtml}"
        >
          ${ExportToHTMLIcon}
        </icon-button>
      </div>
      <div class="button-container">
        <icon-button
          class="button-item"
          text="Notion"
          @click="${this._importNotion}"
        >
          ${NotionIcon}
          <div
            slot="suffix"
            class="has-tool-tip"
            @click="${this._openLearnImportLink}"
          >
            ${HelpIcon}
            <tool-tip inert arrow tip-position="top" role="tooltip">
              Learn how to Import your Notion pages into AFFiNE.
            </tool-tip>
          </div>
        </icon-button>
        <icon-button class="button-item" text="Coming soon..." disabled>
          ${NewIcon}
        </icon-button>
      </div>
      <!-- <div class="footer">
        <div>Migrate from other versions of AFFiNE?</div>
      </div> -->
    `;
  }
}
