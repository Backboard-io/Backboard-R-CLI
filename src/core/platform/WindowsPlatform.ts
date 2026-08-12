import { readFile } from "node:fs/promises";
import { BasePlatform } from "./BasePlatform.ts";
import { pngSize, resizeWithCandidates } from "./png.ts";
import { run, runWithOutput } from "./process.ts";
import type {
	AccessibilitySnapshot,
	ImagePayload,
	PlatformAction,
	ResizePngInput,
	ScreenshotCapture,
} from "./types.ts";

export class WindowsPlatform extends BasePlatform {
	async screenshot(
		path: string,
		signal: AbortSignal,
	): Promise<ScreenshotCapture> {
		const script = [
			"Add-Type -AssemblyName System.Windows.Forms;",
			"Add-Type -AssemblyName System.Drawing;",
			"$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;",
			"$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;",
			"$g=[System.Drawing.Graphics]::FromImage($bmp);",
			"$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);",
			`$bmp.Save(${powershellString(path)},[System.Drawing.Imaging.ImageFormat]::Png);`,
			"$g.Dispose();$bmp.Dispose();",
		].join("");
		await run("powershell.exe", ["-NoProfile", "-Command", script], signal);
		const bytes = await readFile(path);
		const size = pngSize(bytes, "screenshot");
		return { path, bytes, screenSize: size };
	}

	override async accessibilitySnapshot(
		signal: AbortSignal,
	): Promise<AccessibilitySnapshot> {
		try {
			const output = await runWithOutput(
				"powershell.exe",
				["-NoProfile", "-Command", WINDOWS_ACCESSIBILITY_SCRIPT],
				signal,
			);
			const parsed = JSON.parse(output) as AccessibilitySnapshot;
			return {
				appName:
					typeof parsed.appName === "string" ? parsed.appName : undefined,
				processId:
					typeof parsed.processId === "number" ? parsed.processId : undefined,
				windowTitle:
					typeof parsed.windowTitle === "string"
						? parsed.windowTitle
						: undefined,
				elements: Array.isArray(parsed.elements) ? parsed.elements : [],
			};
		} catch {
			return { elements: [] };
		}
	}

	async execute(action: PlatformAction, signal: AbortSignal): Promise<void> {
		switch (action.kind) {
			case "openApp":
				await run(
					"powershell.exe",
					[
						"-NoProfile",
						"-Command",
						`Start-Process ${powershellString(action.appName)}`,
					],
					signal,
				);
				return;
			case "click":
				await run(
					"powershell.exe",
					[
						"-NoProfile",
						"-Command",
						windowsClickScript(
							Math.round(action.point.x),
							Math.round(action.point.y),
							action.button,
						),
					],
					signal,
				);
				return;
			default:
				throw new Error(
					`${action.kind} is not implemented by the Windows platform yet`,
				);
		}
	}

	protected override async resizePng(
		input: ResizePngInput,
	): Promise<ImagePayload | null> {
		return resizeWithCandidates(input, async (width, out) => {
			const script = [
				"Add-Type -AssemblyName System.Drawing;",
				`$src=[System.Drawing.Image]::FromFile(${powershellString(input.path)});`,
				`$w=${width};`,
				"$h=[int]($src.Height*($w/$src.Width));",
				"$bmp=New-Object System.Drawing.Bitmap $w,$h;",
				"$g=[System.Drawing.Graphics]::FromImage($bmp);",
				"$g.DrawImage($src,0,0,$w,$h);",
				`$bmp.Save(${powershellString(out)},[System.Drawing.Imaging.ImageFormat]::Png);`,
				"$g.Dispose();$bmp.Dispose();$src.Dispose();",
			].join("");
			await run(
				"powershell.exe",
				["-NoProfile", "-Command", script],
				input.signal,
			);
		});
	}
}

function powershellString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

const WINDOWS_ACCESSIBILITY_SCRIPT = [
	"Add-Type -AssemblyName UIAutomationClient;",
	"Add-Type -AssemblyName UIAutomationTypes;",
	"$max=80;",
	"$items=New-Object System.Collections.Generic.List[object];",
	"$root=[System.Windows.Automation.AutomationElement]::FocusedElement;",
	"if ($null -eq $root) { $root=[System.Windows.Automation.AutomationElement]::RootElement }",
	"$pidValue=$root.Current.ProcessId;",
	"$appName=$null;",
	"try { $appName=(Get-Process -Id $pidValue).ProcessName } catch {}",
	"$windowTitle=$root.Current.Name;",
	"$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker;",
	"function Add-Node($node,$depth){",
	" if ($null -eq $node -or $items.Count -ge $max -or $depth -gt 4) { return }",
	" $rect=$node.Current.BoundingRectangle;",
	" if (!$rect.IsEmpty -and $rect.Width -gt 0 -and $rect.Height -gt 0) {",
	"  $items.Add([pscustomobject]@{ id=('el_'+($items.Count+1)); appName=$appName; processId=$pidValue; windowTitle=$windowTitle; role=$node.Current.ControlType.ProgrammaticName.Replace('ControlType.',''); name=$node.Current.Name; bounds=[pscustomobject]@{ x=[double]$rect.X; y=[double]$rect.Y; width=[double]$rect.Width; height=[double]$rect.Height }; enabled=[bool]$node.Current.IsEnabled; focused=[bool]$node.Current.HasKeyboardFocus }) | Out-Null",
	" }",
	" $child=$walker.GetFirstChild($node);",
	" while ($null -ne $child -and $items.Count -lt $max) { Add-Node $child ($depth+1); $child=$walker.GetNextSibling($child) }",
	"}",
	"Add-Node $root 0;",
	"[pscustomobject]@{ appName=$appName; processId=$pidValue; windowTitle=$windowTitle; elements=$items } | ConvertTo-Json -Depth 5 -Compress",
].join("");

function windowsClickScript(
	x: number,
	y: number,
	button: "left" | "right" | "middle",
): string {
	const down = { left: 0x0002, right: 0x0008, middle: 0x0020 }[button];
	const up = { left: 0x0004, right: 0x0010, middle: 0x0040 }[button];
	return [
		"Add-Type -AssemblyName System.Windows.Forms;",
		"$signature='[DllImport(\"user32.dll\",CharSet=CharSet.Auto,CallingConvention=CallingConvention.StdCall)] public static extern void mouse_event(long dwFlags,long dx,long dy,long cButtons,long dwExtraInfo);';",
		"Add-Type -MemberDefinition $signature -Name Mouse -Namespace Win32;",
		`[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y});`,
		`[Win32.Mouse]::mouse_event(${down},0,0,0,0);`,
		`[Win32.Mouse]::mouse_event(${up},0,0,0,0);`,
	].join("");
}
