import { FileDiscoveryService, TextChunker } from "../src/core";
import { ContainerFactory, TYPES } from "../src/core/di";
import { IFileProcessor } from "../src/types";
import { HtmlReader } from "../src/core";
import { LoggerFactory } from "../src/shared";
import { promises } from "fs";
import path from "path";

async function main() {
    const logger = LoggerFactory.createLogger({logFile: "", logLevel: "warning", silent: false, debug: false});
    const ds = new FileDiscoveryService({ input: "/Volumes/2TB/idump/11/11/exlibris.org.ua/**", filter: [ "*.html", "*.htm", "*.php*" ], exclude: [] }, logger)
    const hr = new HtmlReader(new TextChunker({ enabled: false, maxChunkSize: 0, overlapSize: 0 }, logger), logger);
    let index = 1;
    for (const file of await ds.discover()) {
        const result = await hr.read(file);
        // console.log(result.chunks[0].content, '\n\n\n\n');
        await promises.writeFile(path.join("./out_litopys.org.ua", (index++).toString() + ".txt"), result.chunks[0].content, 'utf-8');
        logger.info(`File ${file} read and saved to ${index - 1}.txt`);
    }
}

main();