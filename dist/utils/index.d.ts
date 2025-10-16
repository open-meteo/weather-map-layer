import { Domain, Variable, DomainMetaData } from '../types';
import * as maplibregl from 'maplibre-gl';
export declare const pad: (n: string | number) => string;
export declare const closestDomainInterval: (time: Date, domain: Domain) => Date;
export declare const closestModelRun: (domain: Domain, selectedTime: Date, latest?: DomainMetaData) => Date;
export declare const getOMUrl: (time: Date, mode: "dark" | "bright", partial: boolean, domain: Domain, variable: Variable, modelRun: Date, paddedBounds?: maplibregl.LngLatBounds) => string;
