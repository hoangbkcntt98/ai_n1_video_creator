 import { promises as fs } from "node:fs";
 import path from "node:path";
 import { appConfig } from "@/lib/config";
 import { NextResponse } from "next/server";
 
 export const runtime = "nodejs";
 export const dynamic = "force-dynamic";
 
 export async function GET(_request: Request, context: { params: Promise<{ patternName: string }> }) {
   const { patternName } = await context.params;
   
   try {
     // Find the most recent caption file for this pattern
     const dataDir = appConfig.dataDir();
     const entries = await fs.readdir(dataDir, { withFileTypes: true });
     const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse();
     
     for (const dateDir of dirs) {
       const captionPath = path.join(dataDir, dateDir, `${patternName}_reel_caption.txt`);
       try {
         const caption = await fs.readFile(captionPath, "utf-8");
         return NextResponse.json({ caption, dateDir }, { status: 200 });
       } catch {
         // Continue to next directory
       }
     }
     
     return NextResponse.json({ error: "Caption chưa được tạo." }, { status: 404 });
   } catch (error) {
     return NextResponse.json({ error: "Không đọc được caption." }, { status: 500 });
   }
 }
