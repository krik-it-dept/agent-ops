// Static contracts for the NSIS hooks. No installer, registry or process is run.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (file: string): string =>
  readFileSync(resolve(file), 'utf8').replaceAll('\r\n', '\n');

describe('packaging contracts', () => {
  it('packs the platform icon resources and checks each one in packaged smoke', () => {
    expect(read('electron-builder.yml')).toMatch(
      /extraResources:\s+- from: resources\/icons\s+to: icons/,
    );
    const smoke = read('scripts/release/smoke-packaged.mjs');
    for (const icon of [
      'app.ico',
      'app.png',
      'app-light.ico',
      'app-light.png',
      'app-dark.ico',
      'app-dark.png',
    ]) {
      expect(
        readFileSync(resolve('resources/icons', icon)).length,
      ).toBeGreaterThan(0);
      expect(smoke).toContain(`'${icon}'`);
    }
    expect(smoke).toContain("join(resources, 'icons', icon)");
    expect(smoke).toContain("USERPROFILE: join(temp, 'profile')");
    expect(smoke).toContain(
      "LOCALAPPDATA: join(temp, 'profile', 'AppData', 'Local')",
    );
    expect(smoke).not.toContain('statSync(realData)');
    expect(smoke).toContain("const dirOnly = process.argv.includes('--dir')");
    expect(smoke).toContain('} else if (dirOnly) {');
    expect(smoke).toContain(
      "check(false, 'app-update.yml (build the installer, not --dir)')",
    );
  });

  it('runs opt-in skill cleanup after the one-click stop gate and before deleting data', () => {
    // Assert against the pinned template too: this hook relies on its stop gate.
    const template = read(
      'node_modules/app-builder-lib/templates/nsis/uninstaller.nsh',
    );
    const stop = template.indexOf('call un.checkAppRunning');
    const section = template.indexOf('Section "un.${UNINSTALL_SECTION_NAME}"');
    const hook = template.indexOf('!insertmacro customUnInstall');
    expect(stop).toBeGreaterThan(-1);
    expect(section).toBeGreaterThan(stop);
    expect(hook).toBeGreaterThan(section);
    expect(template.slice(stop, section)).toContain('SetSilent silent');

    const script = read('build/installer.nsh');
    const cleanup = script.slice(script.indexOf('!macro customUnInstall'));
    expect(cleanup).toMatch(
      /^!macro customUnInstall\s+\$\{IfNot\} \$\{isUpdated\}/,
    );
    expect(cleanup).toContain(
      '${GetOptions} $R0 "/S" $R1\n    ${If} ${Errors}\n      SetSilent normal',
    );
    expect(cleanup.indexOf('SetSilent normal')).toBeLessThan(
      cleanup.indexOf('MessageBox'),
    );
    expect(cleanup).toMatch(
      /MessageBox MB_YESNO\|MB_ICONQUESTION\|MB_DEFBUTTON2[^\n]+\/SD IDNO IDNO aoKeepSkills/,
    );
    expect(cleanup).toContain(
      'ExecWait \'"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" --cleanup-skills\' $R8',
    );
    expect(cleanup).toContain('${If} ${Errors}\n      ${OrIf} $R8 != "0"');
    expect(cleanup).toContain('Uninstall will continue.');
    expect(cleanup).not.toMatch(/\b(?:Abort|Quit)\b/);
    expect(cleanup.indexOf('ExecWait')).toBeLessThan(
      cleanup.indexOf('aoKeepSkills:'),
    );
    expect(cleanup.indexOf('aoKeepSkills:')).toBeLessThan(
      cleanup.indexOf('DeleteRegValue'),
    );
    expect(cleanup.indexOf('aoKeepSkills:')).toBeLessThan(
      cleanup.indexOf('RMDir /r'),
    );
  });

  it('replaces the stock process checker and never builds PowerShell text from a path', () => {
    const script = read('build/installer.nsh');
    const start = script.indexOf('!macro customCheckAppRunning');
    expect(start).toBeGreaterThan(-1);
    const check = script.slice(start, script.indexOf('!macroend', start));
    expect(check).toContain(
      'stop -Executable "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"',
    );
    expect(check).toMatch(/\$\{If\} \$aoCode != "0"[\s\S]*Quit/);
    // Only the fixed helper runs, with -File; no inline PowerShell, no name-only kill.
    expect(script).not.toMatch(
      /-Command|Get-CimInstance|Stop-Process|taskkill|StartsWith|KILL_PROCESS|FIND_PROCESS/,
    );
    const runs = script.match(/nsExec::\w+ [^\n]+/g) ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain(
      '"${AO_POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\\installer-helper.ps1" ${ARGS}',
    );
    expect(script).toContain(
      '!define AO_POWERSHELL "$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"',
    );
    expect(script).toContain(
      'File "/oname=$PLUGINSDIR\\installer-helper.ps1" "${BUILD_RESOURCES_DIR}\\installer-helper.ps1"',
    );
    // The pinned template skips its own checker when the macro exists.
    const template = read(
      'node_modules/app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh',
    );
    expect(template).toMatch(
      /!ifmacrodef customCheckAppRunning\s+!insertmacro customCheckAppRunning\s+!else\s+!insertmacro IS_POWERSHELL_AVAILABLE\s+!insertmacro _CHECK_APP_RUNNING/,
    );
  });

  it('validates the destination and paths, then recovers before preparing a bootstrap', () => {
    const script = read('build/installer.nsh');
    const init = script.slice(
      script.indexOf('!macro customInit'),
      script.indexOf('!macro customInstall'),
    );
    const order = [
      'aoExtractHelper',
      'check-paths -Expected "${AO_PROGRAMS_DIR}" -Actual "$INSTDIR"',
      'bootstrap-recover',
      'aoLog',
      'bootstrap-prepare',
    ].map((t) => init.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const plain of [
      '${AO_LOG}',
      '${AO_DATA_DIR}\\backups',
      '${AO_JOURNAL}',
      '${AO_RECEIPT}',
    ]) {
      expect(init).toContain(plain);
    }
    // Every helper failure stops setup before files are written.
    expect(init.match(/\$\{If\} \$aoCode != "0"/g)).toHaveLength(3);
    expect(init.match(/\bQuit\b/g)).toHaveLength(3);
    // The Go version is retired by the app's first start, never here.
    expect(script).not.toMatch(
      /Uninstall\\AgentOps|\bRename\b|RMDir \/r "\$\{AO_PROGRAMS_DIR\}"/,
    );
    const install = script.slice(
      script.indexOf('!macro customInstall'),
      script.indexOf('!macro customUnInit'),
    );
    expect(install.indexOf('bootstrap-commit')).toBeGreaterThan(-1);
    expect(install.indexOf('bootstrap-commit')).toBeLessThan(
      install.indexOf('WriteRegStr'),
    );
    expect(read('electron-builder.yml')).toMatch(
      /- from: build\/installer-helper\.ps1\s+to: installer-helper\.ps1/,
    );
  });

  it('refuses unexpected uninstall folders and never deletes data through a link', () => {
    const script = read('build/installer.nsh');
    const unInit = script.slice(
      script.indexOf('!macro customUnInit'),
      script.indexOf('!macro customUnInstall'),
    );
    expect(unInit).toContain(
      'check-paths -Expected "${AO_PROGRAMS_DIR}" -Actual "$INSTDIR" -Tree "$INSTDIR"',
    );
    expect(unInit).toMatch(/\$\{If\} \$aoCode != "0"[\s\S]*Quit/);
    const un = script.slice(script.indexOf('!macro customUnInstall'));
    const guard = un.indexOf('check-paths -Tree "${AO_DATA_DIR}"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(un.indexOf('RMDir /r'));
    expect(un).toMatch(
      /\$\{If\} \$aoCode != "0"\s+MessageBox[^\n]+\s+StrCpy \$R9 "0"/,
    );
  });
});
