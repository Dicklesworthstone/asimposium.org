export interface PlantedDefect {
  readonly id: string;
  readonly bead: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly command: readonly string[];
  readonly note?: string;
}
export declare const PLANTS: readonly PlantedDefect[];
export declare function checkPlants(root: string): string[];
