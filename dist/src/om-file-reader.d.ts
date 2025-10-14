import { OmFileReader } from '@openmeteo/file-reader';
import { ProjectionGrid, Projection } from './utils/projections';
import { Domain, DimensionRange, Variable } from './types';
import { Data } from './om-protocol';
export declare class OMapsFileReader {
    child?: OmFileReader;
    reader?: OmFileReader;
    partial: boolean;
    ranges: DimensionRange[];
    domain: Domain;
    projection: Projection;
    projectionGrid: ProjectionGrid;
    constructor(domain: Domain, partial: boolean);
    init(omUrl: string): Promise<void>;
    setReaderData(domain: Domain, partial: boolean): void;
    setRanges(ranges: DimensionRange[] | null, dimensions: number[] | undefined): void;
    readVariable(variable: Variable, ranges?: DimensionRange[] | null): Promise<Data>;
    getNextUrls(omUrl: string): string[] | undefined;
    prefetch(omUrl: string): void;
    dispose(): void;
}
