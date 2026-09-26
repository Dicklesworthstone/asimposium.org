export interface PlantedDefect {
  readonly id: string;
  readonly bead: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly command: readonly string[];
  readonly note?: string;
  readonly also?: readonly {
    /** Another file this edit applies to; defaults to the plant's file. */
    readonly file?: string;
    readonly find: string;
    readonly replace: string;
    readonly nth?: number;
  }[];
}
export declare const PLANTS: readonly PlantedDefect[];
export declare function checkPlants(root: string): string[];
export declare function classifyPlantRun(run: {
  readonly status: number | null;
  readonly signal: string | null;
  readonly output: string;
}): "caught" | "survived" | "inconclusive";
