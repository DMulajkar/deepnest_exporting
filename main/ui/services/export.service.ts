/**
 * Export Service
 * Handles SVG/DXF/JSON export functionality for nesting results
 * Manages file save dialogs, format conversion, and file writing
 */

import type {
  UIConfig,
  DeepNestInstance,
  SelectableNestingResult,
  Part,
  SvgParserInstance,
} from "../types/index.js";
import { DEFAULT_CONVERSION_SERVER } from "../types/index.js";
import { message } from "../utils/ui-helpers.js";
import { generateHpgl } from "../utils/hpgl.js";
import type { HpglPath } from "../utils/hpgl.js";
import { generatePdf } from "../utils/pdf.js";
import { generateGcode } from "../utils/gcode.js";
import { optimizePathOrder } from "../utils/path-order.js";

/**
 * File filter options for the save dialog
 */
interface FileFilter {
  name: string;
  extensions: string[];
}

/**
 * Save dialog options
 */
interface SaveDialogOptions {
  title: string;
  filters: FileFilter[];
}

/**
 * Dialog interface for Electron's dialog module
 */
interface ElectronDialog {
  showSaveDialogSync(options: SaveDialogOptions): string | undefined;
}

/**
 * Remote interface for Electron's remote module
 */
interface ElectronRemote {
  getGlobal(name: string): string | undefined;
}

/**
 * File system interface for Node.js fs module
 */
interface FileSystem {
  writeFileSync(path: string, data: string): void;
}

/**
 * Axios-like HTTP client interface
 */
interface HttpClient {
  post(
    url: string,
    data: Buffer,
    options: { headers: Record<string, string>; responseType: string }
  ): Promise<{ data: string }>;
}

/**
 * FormData-like interface for file upload
 */
interface FormDataLike {
  append(
    name: string,
    value: Buffer | string,
    options?: { filename?: string; contentType?: string }
  ): void;
  getBuffer(): Buffer;
  getHeaders(): Record<string, string>;
}

/**
 * FormData constructor interface
 */
interface FormDataConstructor {
  new (): FormDataLike;
}

/**
 * Config getter interface
 */
interface ConfigGetter {
  getSync<K extends keyof UIConfig>(key?: K): K extends keyof UIConfig ? UIConfig[K] : UIConfig;
}

/**
 * Placement within a sheet (matches index.d.ts SheetPlacement)
 */
interface PartPlacement {
  id: number;
  filename: string;
  source: number;
  x: number;
  y: number;
  rotation: number;
}

/**
 * Sheet with placements (matches NestingResult.placements structure)
 */
interface SheetGroup {
  sheet: number;
  sheetid: number;
  sheetplacements: PartPlacement[];
}

/**
 * Export button element interface
 */
interface ExportButtonElement extends HTMLElement {
  className: string;
}

/**
 * Export options for SVG generation
 */
export interface ExportOptions {
  /** Whether this export is for DXF conversion (affects scaling) */
  forDxfConversion?: boolean;
}

/**
 * Export file formats
 */
export type ExportFormat = "svg" | "dxf" | "json" | "plt" | "pdf" | "gcode";

/**
 * File filters for export dialogs
 */
const SVG_FILE_FILTERS: FileFilter[] = [
  { name: "SVG", extensions: ["svg"] }
];

const DXF_FILE_FILTERS: FileFilter[] = [
  { name: "DXF/DWG", extensions: ["dxf", "dwg"] }
];

const PLT_FILE_FILTERS: FileFilter[] = [
  { name: "PLT (HPGL)", extensions: ["plt"] }
];

const PDF_FILE_FILTERS: FileFilter[] = [
  { name: "PDF", extensions: ["pdf"] }
];

const GCODE_FILE_FILTERS: FileFilter[] = [
  { name: "G-code", extensions: ["gcode", "nc", "ngc"] }
];

const JSON_FILE_FILTERS: FileFilter[] = [
  { name: "JSON", extensions: ["json"] }
];

/**
 * Export Service class
 * Handles export operations for nesting results to various formats
 * Follows the pattern from main/deepnest.js ES6 class structure
 */
export class ExportService {
  /** Electron dialog for file save dialogs */
  private dialog: ElectronDialog | null = null;

  /** Electron remote for accessing global variables */
  private remote: ElectronRemote | null = null;

  /** Node.js file system module */
  private fs: FileSystem | null = null;

  /** HTTP client for conversion requests */
  private httpClient: HttpClient | null = null;

  /** FormData constructor for file upload */
  private FormData: FormDataConstructor | null = null;

  /** Configuration getter */
  private config: ConfigGetter | null = null;

  /** DeepNest instance for accessing parts and nests */
  private deepNest: DeepNestInstance | null = null;

  /** SvgParser instance for line merging operations */
  private svgParser: SvgParserInstance | null = null;

  /** Export button element for spinner state */
  private exportButton: ExportButtonElement | null = null;

  /** Flag to track if export is busy */
  private isExporting = false;

  /**
   * Create a new ExportService instance
   * Dependencies are injected for testability
   */
  constructor(options?: {
    dialog?: ElectronDialog;
    remote?: ElectronRemote;
    fs?: FileSystem;
    httpClient?: HttpClient;
    FormData?: FormDataConstructor;
    config?: ConfigGetter;
    deepNest?: DeepNestInstance;
    svgParser?: SvgParserInstance;
    exportButton?: ExportButtonElement;
  }) {
    if (options) {
      this.dialog = options.dialog || null;
      this.remote = options.remote || null;
      this.fs = options.fs || null;
      this.httpClient = options.httpClient || null;
      this.FormData = options.FormData || null;
      this.config = options.config || null;
      this.deepNest = options.deepNest || null;
      this.svgParser = options.svgParser || null;
      this.exportButton = options.exportButton || null;
    }
  }

  /**
   * Set the dialog module for file save dialogs
   * @param dialog - Electron dialog module
   */
  setDialog(dialog: ElectronDialog): void {
    this.dialog = dialog;
  }

  /**
   * Set the remote module for accessing globals
   * @param remote - Electron remote module
   */
  setRemote(remote: ElectronRemote): void {
    this.remote = remote;
  }

  /**
   * Set the file system module
   * @param fs - Node.js fs module
   */
  setFileSystem(fs: FileSystem): void {
    this.fs = fs;
  }

  /**
   * Set the HTTP client for conversion requests
   * @param httpClient - HTTP client (e.g., axios)
   */
  setHttpClient(httpClient: HttpClient): void {
    this.httpClient = httpClient;
  }

  /**
   * Set the FormData constructor
   * @param FormData - FormData constructor
   */
  setFormDataConstructor(FormData: FormDataConstructor): void {
    this.FormData = FormData;
  }

  /**
   * Set the configuration getter
   * @param config - Configuration object with getSync method
   */
  setConfig(config: ConfigGetter): void {
    this.config = config;
  }

  /**
   * Set the DeepNest instance
   * @param deepNest - DeepNest instance for accessing parts and nests
   */
  setDeepNest(deepNest: DeepNestInstance): void {
    this.deepNest = deepNest;
  }

  /**
   * Set the SvgParser instance for line merging operations
   * @param svgParser - SvgParser instance
   */
  setSvgParser(svgParser: SvgParserInstance): void {
    this.svgParser = svgParser;
  }

  /**
   * Set the export button element for spinner state
   * @param button - Export button element
   */
  setExportButton(button: ExportButtonElement): void {
    this.exportButton = button;
  }

  /**
   * Get the conversion server URL from config or use default
   * @returns Conversion server URL
   */
  private getConversionServerUrl(): string {
    if (!this.config) {
      return DEFAULT_CONVERSION_SERVER;
    }

    const configUrl = this.config.getSync("conversionServer");
    return configUrl || DEFAULT_CONVERSION_SERVER;
  }

  /**
   * Get the currently selected nesting result
   * @returns Selected nesting result or null if none selected
   */
  private getSelectedNest(): SelectableNestingResult | null {
    if (!this.deepNest) {
      return null;
    }

    const selected = this.deepNest.nests.filter((n) => n.selected);
    if (selected.length === 0) {
      return null;
    }

    return selected[selected.length - 1];
  }

  /**
   * Show the export button as loading
   */
  private setExportLoading(loading: boolean): void {
    if (this.exportButton) {
      if (loading) {
        this.exportButton.className = "button export spinner";
      } else {
        this.exportButton.className = "button export";
      }
    }
  }

  /**
   * Export the selected nest result to JSON file
   * Saves to the NEST_DIRECTORY as exports.json
   * @returns True if export was successful
   */
  exportToJson(): boolean {
    if (!this.remote || !this.fs || !this.deepNest) {
      return false;
    }

    const nestDirectory = this.remote.getGlobal("NEST_DIRECTORY");
    if (!nestDirectory) {
      return false;
    }

    const filePath = nestDirectory + "exports.json";

    const selected = this.getSelectedNest();
    if (!selected) {
      return false;
    }

    const fileData = JSON.stringify(selected);
    this.fs.writeFileSync(filePath, fileData);

    return true;
  }

  /**
   * Show save dialog and export the selected nest result to a JSON file
   * Used by the Export menu; exportToJson stays as the silent save after nesting
   * @returns True if export was successful
   */
  exportToJsonFile(): boolean {
    if (!this.dialog || !this.fs) {
      message("Export dependencies not available", true);
      return false;
    }

    let fileName = this.dialog.showSaveDialogSync({
      title: "Export deepnest JSON",
      filters: JSON_FILE_FILTERS,
    });

    if (fileName === undefined) {
      return false;
    }

    // Ensure .json extension
    if (!fileName.toLowerCase().endsWith(".json")) {
      fileName = fileName + ".json";
    }

    const selected = this.getSelectedNest();
    if (!selected) {
      return false;
    }

    this.fs.writeFileSync(fileName, JSON.stringify(selected));
    return true;
  }

  /**
   * Show save dialog and export to SVG
   * @returns True if export was successful
   */
  exportToSvg(): boolean {
    if (!this.dialog || !this.fs) {
      message("Export dependencies not available", true);
      return false;
    }

    let fileName = this.dialog.showSaveDialogSync({
      title: "Export deepnest SVG",
      filters: SVG_FILE_FILTERS,
    });

    if (fileName === undefined) {
      return false;
    }

    // Ensure .svg extension
    if (!fileName.toLowerCase().endsWith(".svg")) {
      fileName = fileName + ".svg";
    }

    const selected = this.getSelectedNest();
    if (!selected) {
      return false;
    }

    const svgContent = this.generateSvgExport(selected);
    this.fs.writeFileSync(fileName, svgContent);

    return true;
  }

  /**
   * Show save dialog and export to DXF via conversion server
   * @returns Promise that resolves to true if export was successful
   */
  async exportToDxf(): Promise<boolean> {
    if (!this.dialog || !this.fs || !this.httpClient || !this.FormData) {
      message("Export dependencies not available", true);
      return false;
    }

    let fileName = this.dialog.showSaveDialogSync({
      title: "Export deepnest DXF",
      filters: DXF_FILE_FILTERS,
    });

    if (fileName === undefined) {
      return false;
    }

    // Ensure .dxf or .dwg extension
    if (!fileName.toLowerCase().endsWith(".dxf") && !fileName.toLowerCase().endsWith(".dwg")) {
      fileName = fileName + ".dxf";
    }

    const selected = this.getSelectedNest();
    if (!selected) {
      return false;
    }

    const url = this.getConversionServerUrl();
    this.setExportLoading(true);

    try {
      // Generate SVG with DXF scaling
      const svgContent = this.generateSvgExport(selected, { forDxfConversion: true });

      const formData = new this.FormData();
      formData.append("fileUpload", Buffer.from(svgContent), {
        filename: "deepnest.svg",
        contentType: "image/svg+xml",
      });
      formData.append("format", "dxf");

      const response = await this.httpClient.post(url, formData.getBuffer(), {
        headers: formData.getHeaders(),
        responseType: "text",
      });

      const body = response.data;

      // Check for error responses
      if (body.substring(0, 5) === "error") {
        message(body, true);
        return false;
      }

      if (body.includes('"error"') && body.includes('"error_id"')) {
        const jsonErr = JSON.parse(body) as { error_id: string };
        message(
          `There was an Error while converting: ${jsonErr.error_id}<br>Please use this code to open an issue on github.com/deepnest-next/deepnest`,
          true
        );
        return false;
      }

      this.fs.writeFileSync(fileName, body);
      return true;
    } catch (err) {
      const error = err as { response?: { data: string }; message: string };
      const errorData = error.response?.data || error.message;

      if (
        typeof errorData === "string" &&
        errorData.includes('"error"') &&
        errorData.includes('"error_id"')
      ) {
        const jsonErr = JSON.parse(errorData) as { error_id: string };
        message(
          `There was an Error while converting: ${jsonErr.error_id}<br>Please use this code to open an issue on github.com/deepnest-next/deepnest`,
          true
        );
      } else {
        message(
          `Could not contact file conversion server: ${JSON.stringify(err)}<br>Please use this code to open an issue on github.com/deepnest-next/deepnest`,
          true
        );
      }
      return false;
    } finally {
      this.setExportLoading(false);
    }
  }

  /**
   * Show save dialog and export to PLT (HPGL), generated locally from the export SVG
   * @returns True if export was successful
   */
  exportToPlt(): boolean {
    if (!this.dialog || !this.fs || !this.svgParser) {
      message("Export dependencies not available", true);
      return false;
    }

    let fileName = this.dialog.showSaveDialogSync({
      title: "Export deepnest PLT",
      filters: PLT_FILE_FILTERS,
    });

    if (fileName === undefined) {
      return false;
    }

    // Ensure .plt extension
    if (!fileName.toLowerCase().endsWith(".plt")) {
      fileName = fileName + ".plt";
    }

    const flat = this.collectExportPaths("PLT");
    if (!flat) {
      return false;
    }

    this.fs.writeFileSync(fileName, generateHpgl(flat.paths));

    return true;
  }

  /**
   * Show save dialog and export to a single-page vector PDF, generated locally from the export SVG
   * The page is sized to the nest at its real physical size
   * @returns True if export was successful
   */
  exportToPdf(): boolean {
    if (!this.dialog || !this.fs || !this.svgParser) {
      message("Export dependencies not available", true);
      return false;
    }

    let fileName = this.dialog.showSaveDialogSync({
      title: "Export deepnest PDF",
      filters: PDF_FILE_FILTERS,
    });

    if (fileName === undefined) {
      return false;
    }

    // Ensure .pdf extension
    if (!fileName.toLowerCase().endsWith(".pdf")) {
      fileName = fileName + ".pdf";
    }

    const flat = this.collectExportPaths("PDF");
    if (!flat) {
      return false;
    }

    this.fs.writeFileSync(fileName, generatePdf(flat.paths, flat.widthInches, flat.heightInches));

    return true;
  }

  /**
   * Show save dialog and export to G-code (mm, absolute), generated locally from the export SVG
   * Uses the default laser on/off commands (M3/M5) and a 1000 mm/min feed rate
   * @returns True if export was successful
   */
  exportToGcode(): boolean {
    if (!this.dialog || !this.fs || !this.svgParser) {
      message("Export dependencies not available", true);
      return false;
    }

    let fileName = this.dialog.showSaveDialogSync({
      title: "Export deepnest G-code",
      filters: GCODE_FILE_FILTERS,
    });

    if (fileName === undefined) {
      return false;
    }

    // Ensure a G-code extension
    if (!/\.(gcode|nc|ngc)$/i.test(fileName)) {
      fileName = fileName + ".gcode";
    }

    const flat = this.collectExportPaths("G-code");
    if (!flat) {
      return false;
    }

    this.fs.writeFileSync(fileName, generateGcode(flat.paths));

    return true;
  }

  /**
   * Build the selected nest as flattened paths in inches, y pointing up, plus the page size
   * Shared by the PLT, PDF and G-code exports and the toolpath preview, so all of them cut in the same optimized order
   * @param label - Format name used in the error message
   * @returns Paths and size, or null if there is no selected nest or the size is unusable
   */
  collectExportPaths(label: string): {
    paths: HpglPath[];
    widthInches: number;
    heightInches: number;
    inchesPerUnit: number;
    unitsHeight: number;
  } | null {
    const selected = this.getSelectedNest();
    if (!selected || !this.svgParser) {
      return null;
    }

    const svg = this.buildSvgExport(selected);
    const inchesPerUnit = this.getInchesPerSvgUnit(svg);
    if (inchesPerUnit === null) {
      message(`Could not determine the export size for ${label}`, true);
      return null;
    }

    const [, , viewBoxWidth, viewBoxHeight] = (svg.getAttribute("viewBox") || "")
      .split(/[\s,]+/)
      .map(Number);

    this.svgParser.applyTransform(svg);
    this.svgParser.flatten(svg);

    return {
      // Reordered for the shortest tool travel from the machine origin (0,0), holes before outlines
      paths: optimizePathOrder(this.collectHpglPaths(svg, inchesPerUnit)),
      widthInches: viewBoxWidth * inchesPerUnit,
      heightInches: viewBoxHeight * inchesPerUnit,
      inchesPerUnit,
      unitsHeight: viewBoxHeight,
    };
  }

  /**
   * Build the selected nest's toolpath in the coordinates of the nest display SVG (y pointing down)
   * so the preview can be drawn exactly over it. The display stacks sheets 1.1x their height apart
   * while the export stacks them edge to edge (plus the configured gap), so each path is shifted
   * from its export sheet position to its display sheet position.
   * @returns Paths and the machine origin in display units, or null if nothing can be built
   */
  getToolpathData(): { paths: HpglPath[]; origin: { x: number; y: number } } | null {
    const flat = this.collectExportPaths("the toolpath preview");
    const selected = this.getSelectedNest();
    if (!flat || !selected || !this.deepNest || !this.config) {
      return null;
    }

    const exportWithSheetsSpace = !!this.config.getSync("exportWithSheetsSpace");
    const sheetSpace = Number(this.config.getSync("exportWithSheetsSpaceValue")) || 0;
    const sheets = selected.placements as SheetGroup[];

    let exportTop = 0;
    let displayTop = 0;
    const bands = sheets.map((s, i) => {
      const height = this.deepNest!.parts[s.sheet].bounds.height;
      const band = { exportTop, displayTop, height };
      exportTop += height + (exportWithSheetsSpace && i < sheets.length - 1 ? sheetSpace : 0);
      displayTop += 1.1 * height;
      return band;
    });

    const paths = flat.paths.map((path) => {
      // Back to export SVG units, y pointing down
      const points = path.points.map((p) => ({
        x: p.x / flat.inchesPerUnit,
        y: flat.unitsHeight - p.y / flat.inchesPerUnit,
      }));

      // Each path lies within one sheet; pick it by the path's mean y
      const meanY = points.reduce((sum, p) => sum + p.y, 0) / (points.length || 1);
      const band = [...bands].reverse().find((b) => b.exportTop <= meanY) ?? bands[0];
      const shift = band ? band.displayTop - band.exportTop : 0;

      return { closed: path.closed, points: points.map((p) => ({ x: p.x, y: p.y + shift })) };
    });

    const last = bands[bands.length - 1];
    return { paths, origin: { x: 0, y: last ? last.displayTop + last.height : 0 } };
  }

  /**
   * Get the physical size of one SVG user unit in inches
   * applyDimensions sets width as a number plus "mm" or "in", and viewBox "0 0 w h"
   * @param svg - Export SVG element
   * @returns Inches per SVG unit, or null if width/viewBox are unusable
   */
  private getInchesPerSvgUnit(svg: SVGSVGElement): number | null {
    const widthAttr = svg.getAttribute("width") || "";
    const width = parseFloat(widthAttr);
    const viewBoxWidth = Number((svg.getAttribute("viewBox") || "").split(/[\s,]+/)[2]);

    if (!(width > 0) || !(viewBoxWidth > 0)) {
      return null;
    }

    const widthInches = widthAttr.endsWith("mm") ? width / 25.4 : width;
    return widthInches / viewBoxWidth;
  }

  /**
   * Convert the flattened export SVG into HPGL paths in inches, y pointing up
   * SVG y points down and HPGL y points up, hence the flip. polygonify drops a
   * last point equal to the first, which is why the closed flag re-adds it in generateHpgl.
   * @param svg - Flattened export SVG element
   * @param inchesPerUnit - Inches per SVG unit
   * @returns Paths ready for generateHpgl
   */
  private collectHpglPaths(svg: SVGSVGElement, inchesPerUnit: number): HpglPath[] {
    if (!this.svgParser || !this.config) {
      return [];
    }

    const svgParser = this.svgParser;
    const height = Number(svg.getAttribute("viewBox")?.split(/[\s,]+/)[3]);
    const closeTolerance = 0.1 * this.config.getSync("curveTolerance");
    const paths: HpglPath[] = [];

    const elements = Array.prototype.slice.call(svg.children) as SVGElement[];
    elements.forEach((e) => {
      let points: { x: number; y: number }[];
      let closed: boolean;

      if (e.tagName === "line") {
        points = [
          { x: Number(e.getAttribute("x1")), y: Number(e.getAttribute("y1")) },
          { x: Number(e.getAttribute("x2")), y: Number(e.getAttribute("y2")) },
        ];
        closed = false;
      } else if (e.tagName !== "svg" && svgParser.polygonElements.includes(e.tagName)) {
        points = svgParser.polygonify(e);
        closed = svgParser.isClosed(e, closeTolerance);
      } else {
        return;
      }

      paths.push({
        points: points.map((p) => ({
          x: p.x * inchesPerUnit,
          y: (height - p.y) * inchesPerUnit,
        })),
        closed,
      });
    });

    return paths;
  }

  /**
   * Generate SVG content from a nesting result
   * Core function that builds the SVG document from placements
   * @param nestResult - The nesting result to export
   * @param options - Export options
   * @returns SVG content as string
   */
  generateSvgExport(
    nestResult: SelectableNestingResult,
    options: ExportOptions = {}
  ): string {
    return new XMLSerializer().serializeToString(this.buildSvgExport(nestResult, options));
  }

  /**
   * Build the SVG element for a nesting result
   * Shared by the string export (SVG/DXF) and the PLT export, which reads the element directly
   * @param nestResult - The nesting result to export
   * @param options - Export options
   * @returns SVG root element
   */
  private buildSvgExport(
    nestResult: SelectableNestingResult,
    options: ExportOptions = {}
  ): SVGSVGElement {
    if (!this.deepNest || !this.config) {
      throw new Error("DeepNest or config not available");
    }

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    let svgWidth = 0;
    let svgHeight = 0;
    let sheetNumber = 0;

    const parts = this.deepNest.parts;
    const exportWithSheetBoundaries = !!this.config.getSync("exportWithSheetBoundboarders");
    const exportWithSheetsSpace = !!this.config.getSync("exportWithSheetsSpace");
    const exportWithSheetsSpaceValue = this.config.getSync("exportWithSheetsSpaceValue") || 0;

    // Process each sheet placement
    (nestResult.placements as SheetGroup[]).forEach((s) => {
      sheetNumber++;

      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      svg.appendChild(group);

      // Add sheet boundary if configured
      if (exportWithSheetBoundaries) {
        this.addSheetBoundary(group, parts[s.sheet]);
      }

      const sheetBounds = parts[s.sheet].bounds;

      // Position the group
      group.setAttribute(
        "transform",
        `translate(${-sheetBounds.x} ${svgHeight - sheetBounds.y})`
      );

      // Track maximum width
      if (svgWidth < sheetBounds.width) {
        svgWidth = sheetBounds.width;
      }

      // Add each part placement
      s.sheetplacements.forEach((p) => {
        const part = parts[p.source];
        const partGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");

        // Clone all SVG elements from the part
        part.svgelements.forEach((e) => {
          const node = e.cloneNode(false) as Element;

          // Handle image elements with relative paths
          if (node.tagName === "image") {
            const relPath = node.getAttribute("data-href");
            if (relPath) {
              node.setAttribute("href", relPath);
            }
            node.removeAttribute("data-href");
          }

          partGroup.appendChild(node);
        });

        group.appendChild(partGroup);

        // Position and rotate the part
        partGroup.setAttribute(
          "transform",
          `translate(${p.x} ${p.y}) rotate(${p.rotation})`
        );
        partGroup.setAttribute("id", String(p.id));
      });

      // Update height for next sheet
      svgHeight += sheetBounds.height;

      // Add spacing between sheets (except after last sheet)
      if (exportWithSheetsSpace && sheetNumber < (nestResult.placements as SheetGroup[]).length) {
        svgHeight += exportWithSheetsSpaceValue;
      }
    });

    // Calculate final dimensions with scaling
    this.applyDimensions(svg, svgWidth, svgHeight, options);

    // Apply line merging if configured
    this.applyLineMerging(svg, nestResult);

    return svg;
  }

  /**
   * Add sheet boundary to a group
   * @param group - SVG group element
   * @param sheetPart - Part representing the sheet
   */
  private addSheetBoundary(group: SVGGElement, sheetPart: Part): void {
    sheetPart.svgelements.forEach((e) => {
      const node = e.cloneNode(false) as SVGElement;
      node.setAttribute("stroke", "#00ff00");
      node.setAttribute("fill", "none");
      group.appendChild(node);
    });
  }

  /**
   * Apply dimensions and viewBox to the SVG element
   * @param svg - SVG element
   * @param width - Content width in SVG units
   * @param height - Content height in SVG units
   * @param options - Export options
   */
  private applyDimensions(
    svg: SVGSVGElement,
    width: number,
    height: number,
    options: ExportOptions
  ): void {
    if (!this.config) {
      return;
    }

    let scale = this.config.getSync("scale");

    // Apply DXF export scale if converting to DXF
    if (options.forDxfConversion) {
      const dxfExportScale = Number(this.config.getSync("dxfExportScale")) || 1;
      scale /= dxfExportScale;
    }

    // Convert scale based on units
    const units = this.config.getSync("units");
    if (units === "mm") {
      scale /= 25.4;
    }

    // Set dimensions with unit suffix
    const unitSuffix = units === "inch" ? "in" : "mm";
    svg.setAttribute("width", `${width / scale}${unitSuffix}`);
    svg.setAttribute("height", `${height / scale}${unitSuffix}`);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }

  /**
   * Apply line merging optimization if configured
   * @param svg - SVG element
   * @param nestResult - Nesting result with merged length info
   */
  private applyLineMerging(
    svg: SVGSVGElement,
    nestResult: SelectableNestingResult
  ): void {
    if (!this.config || !this.svgParser) {
      return;
    }

    const mergeLines = this.config.getSync("mergeLines");
    const mergedLength = (nestResult as unknown as { mergedLength?: number }).mergedLength;

    if (mergeLines && mergedLength && mergedLength > 0) {
      const curveTolerance = this.config.getSync("curveTolerance");

      // Apply SVG processing for line optimization
      this.svgParser.applyTransform(svg);
      this.svgParser.flatten(svg);
      this.svgParser.splitLines(svg);
      this.svgParser.mergeOverlap(svg, 0.1 * curveTolerance);
      this.svgParser.mergeLines(svg);

      // Set stroke and fill for all non-group, non-image elements
      const elements = Array.prototype.slice.call(svg.children) as Element[];
      elements.forEach((e) => {
        if (e.tagName !== "g" && e.tagName !== "image") {
          e.setAttribute("fill", "none");
          e.setAttribute("stroke", "#000000");
        }
      });
    }
  }

  /**
   * Export to the specified format
   * @param format - Export format (svg, dxf, or json)
   * @returns Promise that resolves to true if export was successful
   */
  async export(format: ExportFormat): Promise<boolean> {
    if (this.isExporting) {
      return false;
    }

    this.isExporting = true;

    try {
      switch (format) {
        case "svg":
          return this.exportToSvg();
        case "dxf":
          return await this.exportToDxf();
        case "json":
          return this.exportToJson();
        case "plt":
          return this.exportToPlt();
        case "pdf":
          return this.exportToPdf();
        case "gcode":
          return this.exportToGcode();
        default:
          message(`Unsupported export format: ${format}`, true);
          return false;
      }
    } finally {
      this.isExporting = false;
    }
  }

  /**
   * Check if export is currently in progress
   * @returns True if exporting
   */
  isExportInProgress(): boolean {
    return this.isExporting;
  }

  /**
   * Check if there is a selected nest result available for export
   * @returns True if a nest result is selected
   */
  hasSelectedNest(): boolean {
    return this.getSelectedNest() !== null;
  }

  /**
   * Get supported export formats
   * @returns Array of supported format strings
   */
  static getSupportedFormats(): ExportFormat[] {
    return ["svg", "dxf", "json", "plt", "pdf", "gcode"];
  }

  /**
   * Get file filters for a specific format
   * @param format - Export format
   * @returns Array of file filters
   */
  static getFileFilters(format: ExportFormat): FileFilter[] {
    switch (format) {
      case "svg":
        return [...SVG_FILE_FILTERS];
      case "dxf":
        return [...DXF_FILE_FILTERS];
      case "plt":
        return [...PLT_FILE_FILTERS];
      case "pdf":
        return [...PDF_FILE_FILTERS];
      case "gcode":
        return [...GCODE_FILE_FILTERS];
      default:
        return [];
    }
  }

  /**
   * Create and return a new ExportService instance
   * @param options - Optional configuration options
   * @returns New ExportService instance
   */
  static create(options?: ConstructorParameters<typeof ExportService>[0]): ExportService {
    return new ExportService(options);
  }
}

/**
 * Factory function to create an export service
 * @param options - Optional configuration options
 * @returns New ExportService instance
 */
export function createExportService(
  options?: ConstructorParameters<typeof ExportService>[0]
): ExportService {
  return ExportService.create(options);
}
