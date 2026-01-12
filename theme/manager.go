package theme

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"sort"
	"strings"
)

// Manager manages theme templates and schemes.
type Manager struct {
	templatesMap  map[string]*TemplateInfo
	templatesList []string
}

// NewManager creates a new theme manager and loads templates from the embedded filesystem.
func NewManager(templatesFS embed.FS) (*Manager, error) {
	m := &Manager{
		templatesMap:  make(map[string]*TemplateInfo),
		templatesList: []string{},
	}

	if err := m.loadTemplates(templatesFS); err != nil {
		return nil, fmt.Errorf("load templates: %w", err)
	}

	return m, nil
}

func (m *Manager) loadTemplates(templatesFS embed.FS) error {
	entries, err := fs.ReadDir(templatesFS, "templates")
	if err != nil {
		return fmt.Errorf("read templates directory: %w", err)
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".css") {
			continue
		}

		cssContent, err := templatesFS.ReadFile("templates/" + entry.Name())
		if err != nil {
			log.Printf("Warning: failed to read template %s: %v", entry.Name(), err)
			continue
		}

		schemes, baseCSS := ParseSchemesFromTemplate(string(cssContent))
		if len(schemes) == 0 {
			log.Printf("Warning: no schemes found in template %s", entry.Name())
			continue
		}

		// Get template name from metadata
		templateName := ""
		content := string(cssContent)
		pos := 0
		for pos < len(content) {
			metaStart := strings.Index(content[pos:], "/*")
			if metaStart == -1 {
				break
			}
			metaStart += pos
			metaEnd := strings.Index(content[metaStart:], "*/")
			if metaEnd == -1 {
				break
			}
			metaEnd += metaStart
			metadataBlock := content[metaStart+2 : metaEnd]
			if strings.Contains(metadataBlock, "Template:") {
				meta := ParseThemeMetadata(content[metaStart : metaEnd+2])
				if meta.Template != "" {
					templateName = meta.Template
					break
				}
			}
			pos = metaEnd + 2
		}
		if templateName == "" {
			templateName = strings.TrimSuffix(entry.Name(), ".css")
		}

		templateInfo := &TemplateInfo{
			Name:    templateName,
			BaseCSS: baseCSS,
			Schemes: make(map[string]SchemeInfo),
		}

		for _, scheme := range schemes {
			templateInfo.Schemes[scheme.Name] = scheme
		}

		m.templatesMap[templateName] = templateInfo
		m.templatesList = append(m.templatesList, templateName)
	}

	m.templatesList = sortTemplates(m.templatesList)

	log.Printf("Loaded %d theme templates:", len(m.templatesMap))
	for name, info := range m.templatesMap {
		schemeNames := make([]string, 0, len(info.Schemes))
		for schemeName := range info.Schemes {
			schemeNames = append(schemeNames, schemeName)
		}
		log.Printf("  - %s: %d schemes (%s)", name, len(info.Schemes), strings.Join(schemeNames, ", "))
	}

	return nil
}

func sortTemplates(templates []string) []string {
	preferredOrder := []string{"speedplane", "nordic", "modern", "minimal", "matrix", "ocean", "forest", "bladerunner", "alien", "youtube"}
	var sorted []string
	var others []string

	for _, preferred := range preferredOrder {
		for _, t := range templates {
			if t == preferred {
				sorted = append(sorted, t)
				break
			}
		}
	}

	for _, t := range templates {
		found := false
		for _, preferred := range preferredOrder {
			if t == preferred {
				found = true
				break
			}
		}
		if !found {
			others = append(others, t)
		}
	}

	sort.Strings(others)

	return append(sorted, others...)
}

// GetTemplate returns a template by name, or nil if not found.
func (m *Manager) GetTemplate(name string) *TemplateInfo {
	return m.templatesMap[name]
}

// ListTemplates returns a list of all template names.
func (m *Manager) ListTemplates() []string {
	return m.templatesList
}

// GetThemeCSS returns the combined CSS for a template and scheme.
func (m *Manager) GetThemeCSS(templateName, schemeName string) string {
	templateInfo, exists := m.templatesMap[templateName]
	if !exists {
		return ""
	}

	scheme, schemeExists := templateInfo.Schemes[schemeName]
	if !schemeExists {
		// Try default scheme
		if defaultScheme, hasDefault := templateInfo.Schemes["default"]; hasDefault {
			return defaultScheme.CSS + "\n" + templateInfo.BaseCSS
		}
		return ""
	}

	return scheme.CSS + "\n" + templateInfo.BaseCSS
}

// GetSchemes returns all schemes for a template.
func (m *Manager) GetSchemes(templateName string) []SchemeInfo {
	templateInfo, exists := m.templatesMap[templateName]
	if !exists {
		return nil
	}

	schemeNames := make([]string, 0, len(templateInfo.Schemes))
	for name := range templateInfo.Schemes {
		schemeNames = append(schemeNames, name)
	}

	// Sort schemes: default first, then alphabetically
	for i := 0; i < len(schemeNames); i++ {
		for j := i + 1; j < len(schemeNames); j++ {
			if schemeNames[i] == "default" {
				continue
			}
			if schemeNames[j] == "default" || (schemeNames[i] > schemeNames[j] && schemeNames[j] != "default") {
				schemeNames[i], schemeNames[j] = schemeNames[j], schemeNames[i]
			}
		}
	}

	schemes := make([]SchemeInfo, 0, len(schemeNames))
	for _, schName := range schemeNames {
		schemes = append(schemes, templateInfo.Schemes[schName])
	}

	return schemes
}
