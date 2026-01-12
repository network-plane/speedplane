package theme

// ThemeMetadata represents metadata parsed from CSS template files.
type ThemeMetadata struct {
	Template string
	Scheme   string
	Accent   string
	Display  string
	Border   bool
}

// TemplateInfo contains information about a CSS template and its color schemes.
type TemplateInfo struct {
	Name    string
	BaseCSS string
	Schemes map[string]SchemeInfo
}

// SchemeInfo contains information about a color scheme within a template.
type SchemeInfo struct {
	Name    string
	Accent  string
	Display string
	Border  bool
	CSS     string
}
