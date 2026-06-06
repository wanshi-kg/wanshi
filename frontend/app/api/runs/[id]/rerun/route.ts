import { NextResponse } from "next/server"
import { rerunRun, type RerunMode } from "@/server/run-registry"

export const dynamic = "force-dynamic"

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await req.json().catch(() => null)
  const mode = body?.mode as RerunMode | undefined
  if (mode !== "resume" && mode !== "restart") {
    return NextResponse.json(
      { error: "mode must be 'resume' or 'restart'" },
      { status: 400 }
    )
  }
  const run = rerunRun(id, mode)
  if (!run) {
    return NextResponse.json(
      { error: "No stored config for this run" },
      { status: 404 }
    )
  }
  return NextResponse.json({ run }, { status: 201 })
}
