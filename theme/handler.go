package theme

import (
	"encoding/json"
	"net/http"
	"strings"
)

// Handler handles theme-related HTTP requests.
type Handler struct {
	manager *Manager
}

// NewHandler creates a new theme handler.
func NewHandler(manager *Manager) *Handler {
	return &Handler{
		manager: manager,
	}
}

// HandleTheme serves the CSS for a specific template and scheme.
func (h *Handler) HandleTheme(w http.ResponseWriter, r *http.Request) {
	templateName := "speedplane"
	schemeName := "default"

	if qTemplate := r.URL.Query().Get("template"); qTemplate != "" {
		if h.manager.GetTemplate(qTemplate) != nil {
			templateName = qTemplate
		}
	}
	if qScheme := r.URL.Query().Get("scheme"); qScheme != "" {
		if templateInfo := h.manager.GetTemplate(templateName); templateInfo != nil {
			if _, schemeExists := templateInfo.Schemes[qScheme]; schemeExists {
				schemeName = qScheme
			}
		}
	}

	themeCSS := h.manager.GetThemeCSS(templateName, schemeName)

	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write([]byte(themeCSS))
}

// HandleSchemes returns available schemes for a template.
func (h *Handler) HandleSchemes(w http.ResponseWriter, r *http.Request) {
	templateName := r.URL.Query().Get("template")
	if templateName == "" {
		http.Error(w, "template parameter required", http.StatusBadRequest)
		return
	}

	templateInfo := h.manager.GetTemplate(templateName)
	if templateInfo == nil {
		http.Error(w, "template not found", http.StatusNotFound)
		return
	}

	schemes := h.manager.GetSchemes(templateName)

	type SchemeResponse struct {
		Name    string `json:"name"`
		Display string `json:"display"`
		Accent  string `json:"accent"`
		Border  bool   `json:"border"`
	}

	schemesResp := make([]SchemeResponse, 0, len(schemes))
	for _, scheme := range schemes {
		displayName := scheme.Display
		if displayName == "" {
			parts := strings.Split(scheme.Name, "-")
			for i, part := range parts {
				if len(part) > 0 {
					parts[i] = strings.ToUpper(part[:1]) + part[1:]
				}
			}
			displayName = strings.Join(parts, " ")
		}
		schemesResp = append(schemesResp, SchemeResponse{
			Name:    scheme.Name,
			Display: displayName,
			Accent:  scheme.Accent,
			Border:  scheme.Border,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	if err := json.NewEncoder(w).Encode(schemesResp); err != nil {
		http.Error(w, "failed to encode schemes", http.StatusInternalServerError)
		return
	}
}

// GenerateTemplateMenuHTML generates HTML for the template selection menu.
func (h *Handler) GenerateTemplateMenuHTML(currentTemplate string) string {
	var builder strings.Builder
	templates := h.manager.ListTemplates()

	for _, tmplName := range templates {
		displayName := strings.ToUpper(tmplName[:1]) + tmplName[1:]
		builder.WriteString(`<button data-template="`)
		builder.WriteString(tmplName)
		builder.WriteString(`"`)
		if tmplName == currentTemplate {
			builder.WriteString(` class="active"`)
		}
		builder.WriteString(`>`)
		builder.WriteString(displayName)
		builder.WriteString(`</button>`)
	}

	return builder.String()
}

// GenerateSchemeMenuHTML generates HTML for the scheme selection menu.
func (h *Handler) GenerateSchemeMenuHTML(templateName string) string {
	var builder strings.Builder
	templateInfo := h.manager.GetTemplate(templateName)
	if templateInfo == nil {
		return ""
	}

	schemes := h.manager.GetSchemes(templateName)

	for _, scheme := range schemes {
		displayName := scheme.Display
		if displayName == "" {
			parts := strings.Split(scheme.Name, "-")
			for i, part := range parts {
				if len(part) > 0 {
					parts[i] = strings.ToUpper(part[:1]) + part[1:]
				}
			}
			displayName = strings.Join(parts, " ")
		}

		builder.WriteString(`<button data-scheme="`)
		builder.WriteString(scheme.Name)
		builder.WriteString(`"><i class="fas fa-circle" style="color:`)
		builder.WriteString(scheme.Accent)
		if scheme.Border {
			builder.WriteString(`; border:1px solid rgba(136,192,208,.5);`)
		}
		builder.WriteString(`;"></i> `)
		builder.WriteString(displayName)
		builder.WriteString(`</button>`)
	}

	return builder.String()
}
