package theme

import (
	"strings"
)

// findBlockEnd finds the end of a CSS block (the matching closing brace)
func findBlockEnd(content string, startPos int) int {
	if startPos >= len(content) {
		return len(content)
	}

	openBrace := strings.Index(content[startPos:], "{")
	if openBrace == -1 {
		return len(content)
	}
	openBrace += startPos

	depth := 1
	pos := openBrace + 1
	for pos < len(content) && depth > 0 {
		switch content[pos] {
		case '{':
			depth++
		case '}':
			depth--
		}
		pos++
	}

	return pos
}

// ParseThemeMetadata parses metadata from a CSS comment block.
func ParseThemeMetadata(cssContent string) ThemeMetadata {
	meta := ThemeMetadata{
		Template: "",
		Scheme:   "",
		Accent:   "rgba(136,192,208,.85)",
		Display:  "",
		Border:   false,
	}

	startIdx := strings.Index(cssContent, "/*")
	if startIdx == -1 {
		return meta
	}

	endIdx := strings.Index(cssContent[startIdx:], "*/")
	if endIdx == -1 {
		return meta
	}

	metadataBlock := cssContent[startIdx+2 : startIdx+endIdx]
	lines := strings.Split(metadataBlock, "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Template:") {
			meta.Template = strings.TrimSpace(strings.TrimPrefix(line, "Template:"))
		} else if strings.HasPrefix(line, "Scheme:") {
			meta.Scheme = strings.TrimSpace(strings.TrimPrefix(line, "Scheme:"))
		} else if strings.HasPrefix(line, "Accent:") {
			meta.Accent = strings.TrimSpace(strings.TrimPrefix(line, "Accent:"))
		} else if strings.HasPrefix(line, "Display:") {
			meta.Display = strings.TrimSpace(strings.TrimPrefix(line, "Display:"))
		} else if strings.HasPrefix(line, "Border:") {
			borderVal := strings.TrimSpace(strings.TrimPrefix(line, "Border:"))
			meta.Border = borderVal == "true" || borderVal == "1" || borderVal == "yes"
		}
	}

	return meta
}

// ParseSchemesFromTemplate parses all schemes and base CSS from a template file.
// This is the EXACT code from homepage/main.go parseSchemesFromTemplate
func ParseSchemesFromTemplate(cssContent string) ([]SchemeInfo, string) {
	var schemes []SchemeInfo
	content := cssContent
	pos := 0
	lastSchemeEnd := 0

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

		metadataBlock := content[metaStart : metaEnd+2]
		meta := ParseThemeMetadata(metadataBlock)

		if meta.Template == "" || meta.Scheme == "" {
			pos = metaEnd + 2
			continue
		}

		schemeSelector := `[data-scheme="` + meta.Scheme + `"]`
		schemeStart := strings.Index(content[metaEnd:], schemeSelector)
		isWrappedFormat := true
		if schemeStart == -1 {
			rootStart := strings.Index(content[metaEnd:], ":root")
			if rootStart == -1 {
				pos = metaEnd + 2
				continue
			}
			schemeStart = rootStart + metaEnd
			isWrappedFormat = false
		} else {
			schemeStart += metaEnd
		}

		var schemeEnd int
		if isWrappedFormat {
			nextMetaStart := strings.Index(content[schemeStart:], "/*")
			if nextMetaStart == -1 {
				baseCSSMarker := strings.Index(content[schemeStart:], "/* Base CSS")
				if baseCSSMarker != -1 {
					schemeEnd = schemeStart + baseCSSMarker
				} else {
					schemeEnd = len(content)
				}
			} else {
				nextMetaPos := schemeStart + nextMetaStart
				nextMetaEnd := strings.Index(content[nextMetaPos:], "*/")
				if nextMetaEnd != -1 {
					nextMetaBlock := content[nextMetaPos : nextMetaPos+nextMetaEnd+2]
					nextMeta := ParseThemeMetadata(nextMetaBlock)
					if nextMeta.Template != "" && nextMeta.Scheme != "" {
						schemeEnd = nextMetaPos
					} else {
						schemeEnd = nextMetaPos
					}
				} else {
					schemeEnd = schemeStart + nextMetaStart
				}
			}
		} else {
			rootBlockEnd := findBlockEnd(content, schemeStart)
			schemeEnd = rootBlockEnd

			bodyStart := strings.Index(content[schemeEnd:], "body{")
			if bodyStart != -1 && bodyStart < 50 {
				bodyBlockEnd := findBlockEnd(content, schemeEnd+bodyStart)
				schemeEnd = bodyBlockEnd
			}
		}

		schemeCSS := strings.TrimSpace(content[schemeStart:schemeEnd])
		lastSchemeEnd = schemeEnd

		if !strings.HasPrefix(schemeCSS, `[data-scheme="`) {
			wrappedCSS := `[data-scheme="` + meta.Scheme + `"] ` + schemeCSS
			schemeCSS = wrappedCSS
		}

		alreadyExists := false
		for _, existingScheme := range schemes {
			if existingScheme.Name == meta.Scheme {
				alreadyExists = true
				break
			}
		}

		if !alreadyExists {
			schemes = append(schemes, SchemeInfo{
				Name:    meta.Scheme,
				Accent:  meta.Accent,
				Display: meta.Display,
				Border:  meta.Border,
				CSS:     schemeCSS,
			})
		}

		pos = schemeEnd
	}

	baseCSSStart := strings.Index(content, "/* Base CSS")
	if baseCSSStart != -1 {
		baseCSSEnd := strings.Index(content[baseCSSStart:], "*/")
		if baseCSSEnd != -1 {
			baseCSSStart = baseCSSStart + baseCSSEnd + 2
			for baseCSSStart < len(content) && (content[baseCSSStart] == ' ' || content[baseCSSStart] == '\n' || content[baseCSSStart] == '\r' || content[baseCSSStart] == '\t') {
				baseCSSStart++
			}
		}
	} else {
		baseCSSStart = lastSchemeEnd
		for baseCSSStart < len(content) && (content[baseCSSStart] == ' ' || content[baseCSSStart] == '\n' || content[baseCSSStart] == '\r' || content[baseCSSStart] == '\t') {
			baseCSSStart++
		}
	}

	baseCSS := strings.TrimSpace(content[baseCSSStart:])

	return schemes, baseCSS
}
