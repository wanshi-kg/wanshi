


export interface DotExportOptions {
    layout?: 'dot' | 'neato' | 'fdp' | 'sfdp' | 'circo' | 'twopi';
    rankdir?: 'TB' | 'BT' | 'LR' | 'RL';
    nodeShape?: string;
    edgeStyle?: string;
    colorScheme?: 'default' | 'scientific' | 'code' | 'minimal';
    includeObservations?: boolean;
    maxObservationsPerNode?: number;
    clusterByEntityType?: boolean;
    clusterByFile?: boolean;
    showLegend?: boolean;
}
