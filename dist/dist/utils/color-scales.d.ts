export namespace colorScales {
    export namespace cape {
        let min: number;
        let max: number;
        let scalefactor: number;
        let colors: any[][];
        let interpolationMethod: string;
        let unit: string;
    }
    export namespace cloud_base {
        let min_1: number;
        export { min_1 as min };
        let max_1: number;
        export { max_1 as max };
        let scalefactor_1: number;
        export { scalefactor_1 as scalefactor };
        let colors_1: any[][];
        export { colors_1 as colors };
        let interpolationMethod_1: string;
        export { interpolationMethod_1 as interpolationMethod };
        let unit_1: string;
        export { unit_1 as unit };
    }
    export namespace cloud_cover {
        let min_2: number;
        export { min_2 as min };
        let max_2: number;
        export { max_2 as max };
        let scalefactor_2: number;
        export { scalefactor_2 as scalefactor };
        let colors_2: any[][];
        export { colors_2 as colors };
        let interpolationMethod_2: string;
        export { interpolationMethod_2 as interpolationMethod };
        let unit_2: string;
        export { unit_2 as unit };
    }
    export { convectiveCloudScale as convective_cloud_top };
    export { convectiveCloudScale as convective_cloud_base };
    export { precipScale as precipitation };
    export namespace pressure {
        let min_3: number;
        export { min_3 as min };
        let max_3: number;
        export { max_3 as max };
        let scalefactor_3: number;
        export { scalefactor_3 as scalefactor };
        let colors_3: any[][];
        export { colors_3 as colors };
        let interpolationMethod_3: string;
        export { interpolationMethod_3 as interpolationMethod };
        let unit_3: string;
        export { unit_3 as unit };
    }
    export { precipScale as rain };
    export namespace relative {
        let min_4: number;
        export { min_4 as min };
        let max_4: number;
        export { max_4 as max };
        let scalefactor_4: number;
        export { scalefactor_4 as scalefactor };
        let colors_4: any[][];
        export { colors_4 as colors };
        let interpolationMethod_4: string;
        export { interpolationMethod_4 as interpolationMethod };
        let unit_4: string;
        export { unit_4 as unit };
    }
    export namespace shortwave {
        let min_5: number;
        export { min_5 as min };
        let max_5: number;
        export { max_5 as max };
        let scalefactor_5: number;
        export { scalefactor_5 as scalefactor };
        let colors_5: any[][];
        export { colors_5 as colors };
        let interpolationMethod_5: string;
        export { interpolationMethod_5 as interpolationMethod };
        let unit_5: string;
        export { unit_5 as unit };
    }
    export namespace temperature {
        let min_6: number;
        export { min_6 as min };
        let max_6: number;
        export { max_6 as max };
        let scalefactor_6: number;
        export { scalefactor_6 as scalefactor };
        let colors_6: any[][];
        export { colors_6 as colors };
        let interpolationMethod_6: string;
        export { interpolationMethod_6 as interpolationMethod };
        let unit_6: string;
        export { unit_6 as unit };
    }
    export namespace thunderstorm {
        let min_7: number;
        export { min_7 as min };
        let max_7: number;
        export { max_7 as max };
        let scalefactor_7: number;
        export { scalefactor_7 as scalefactor };
        let colors_7: any[][];
        export { colors_7 as colors };
        let interpolationMethod_7: string;
        export { interpolationMethod_7 as interpolationMethod };
        let unit_7: string;
        export { unit_7 as unit };
    }
    export namespace swell {
        let min_8: number;
        export { min_8 as min };
        let max_8: number;
        export { max_8 as max };
        let scalefactor_8: number;
        export { scalefactor_8 as scalefactor };
        let colors_8: any[][];
        export { colors_8 as colors };
        let interpolationMethod_8: string;
        export { interpolationMethod_8 as interpolationMethod };
        let unit_8: string;
        export { unit_8 as unit };
    }
    export namespace uv {
        let min_9: number;
        export { min_9 as min };
        let max_9: number;
        export { max_9 as max };
        let scalefactor_9: number;
        export { scalefactor_9 as scalefactor };
        let colors_9: any[][];
        export { colors_9 as colors };
        let interpolationMethod_9: string;
        export { interpolationMethod_9 as interpolationMethod };
        let unit_9: string;
        export { unit_9 as unit };
    }
    export namespace wave {
        let min_10: number;
        export { min_10 as min };
        let max_10: number;
        export { max_10 as max };
        let scalefactor_10: number;
        export { scalefactor_10 as scalefactor };
        let colors_10: any[][];
        export { colors_10 as colors };
        let interpolationMethod_10: string;
        export { interpolationMethod_10 as interpolationMethod };
        let unit_10: string;
        export { unit_10 as unit };
    }
    export namespace wind {
        let min_11: number;
        export { min_11 as min };
        let max_11: number;
        export { max_11 as max };
        let scalefactor_11: number;
        export { scalefactor_11 as scalefactor };
        let colors_11: any[][];
        export { colors_11 as colors };
        let interpolationMethod_11: string;
        export { interpolationMethod_11 as interpolationMethod };
        let unit_11: string;
        export { unit_11 as unit };
    }
}
export function getColorScale(variable: any): any;
export function getInterpolator(colorScale: any): (values: any, index: any, xFraction: any, yFraction: any, ranges: any) => number;
declare namespace convectiveCloudScale {
    let min_12: number;
    export { min_12 as min };
    let max_12: number;
    export { max_12 as max };
    let scalefactor_12: number;
    export { scalefactor_12 as scalefactor };
    let colors_12: any[][];
    export { colors_12 as colors };
    let interpolationMethod_12: string;
    export { interpolationMethod_12 as interpolationMethod };
    let unit_12: string;
    export { unit_12 as unit };
}
declare namespace precipScale {
    let min_13: number;
    export { min_13 as min };
    let max_13: number;
    export { max_13 as max };
    let scalefactor_13: number;
    export { scalefactor_13 as scalefactor };
    let colors_13: any[][];
    export { colors_13 as colors };
    let interpolationMethod_13: string;
    export { interpolationMethod_13 as interpolationMethod };
    let unit_13: string;
    export { unit_13 as unit };
}
export {};
