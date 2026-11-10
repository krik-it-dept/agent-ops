package main

import "golang.org/x/sys/windows/registry"

// Only the shell's system theme determines tray contrast, independently of the UI.
func taskbarIconName() string {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE)
	if err != nil {
		return "app.ico"
	}
	defer k.Close()
	value, _, err := k.GetIntegerValue("SystemUsesLightTheme")
	return taskbarIconForValue(value, err)
}

func taskbarIconForValue(value uint64, err error) string {
	if err == nil {
		switch value {
		case 1:
			return "app-light.ico"
		case 0:
			return "app-dark.ico"
		}
	}
	return "app.ico"
}

func trayIcon(name string) []byte {
	data, err := iconFiles.ReadFile("web/icons/" + name)
	if err != nil {
		data, _ = iconFiles.ReadFile("web/icons/app.ico")
	}
	return data
}
