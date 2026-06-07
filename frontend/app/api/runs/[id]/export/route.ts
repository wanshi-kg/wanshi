import { NextResponse } from "next/server"
import {
  EXPORT_FORMATS,
  NoGraphError,
  exportGraph,
  type ExportFormat,
} from "@/server/exporter"

export const dynamic = "force-dynamic"

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await req.json().catch(() => null)
  const format = body?.format as ExportFormat | undefined
  if (!format || !EXPORT_FORMATS.includes(format)) {
    return NextResponse.json(
      { error: `format must be one of: ${EXPORT_FORMATS.join(", ")}` },
      { status: 400 }
    )
  }
  try {
    const result = await exportGraph(id, format)
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof NoGraphError) {
      return NextResponse.json({ error: err.message }, { status: 404 })
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "export failed" },
      { status: 500 }
    )
  }
}
