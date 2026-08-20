package speedtest

import (
	"context"
	"fmt"
	"sort"
	"strings"

	st "github.com/showwin/speedtest-go/speedtest"
)

// CityLocation identifies a speedtest server city anywhere in the world.
type CityLocation struct {
	City    string `json:"city"`
	Country string `json:"country"`
}

// CitiesResult lists speedtest server cities returned by a search or nearby query.
type CitiesResult struct {
	Query           string         `json:"query,omitempty"`
	DetectedCountry string         `json:"detected_country,omitempty"`
	Source          string         `json:"source"`
	Locations       []CityLocation `json:"locations"`
}

// SearchCities finds server cities using Ookla's search API (global) or nearby servers when query is empty.
func SearchCities(ctx context.Context, query string) (*CitiesResult, error) {
	query = strings.TrimSpace(query)

	var client *st.Speedtest
	if query != "" {
		client = st.New(st.WithUserConfig(&st.UserConfig{Keyword: query}))
	} else {
		client = st.New()
	}

	result := &CitiesResult{Query: query}

	if _, err := client.FetchUserInfoContext(ctx); err != nil {
		return nil, fmt.Errorf("fetch user info: %w", err)
	}

	servers, err := client.FetchServerListContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("fetch server list: %w", err)
	}

	if len(servers) > 0 {
		result.DetectedCountry = strings.TrimSpace(servers[0].Country)
	}

	result.Locations = locationsFromServers(servers)
	if query != "" {
		result.Source = "search"
	} else {
		result.Source = "nearby"
	}

	return result, nil
}

func locationsFromServers(servers st.Servers) []CityLocation {
	seen := make(map[string]struct{})
	locations := make([]CityLocation, 0, len(servers))

	for _, server := range servers {
		city := strings.TrimSpace(server.Name)
		country := strings.TrimSpace(server.Country)
		if city == "" || country == "" {
			continue
		}

		key := strings.ToLower(city + "|" + country)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		locations = append(locations, CityLocation{City: city, Country: country})
	}

	sort.Slice(locations, func(i, j int) bool {
		if !strings.EqualFold(locations[i].Country, locations[j].Country) {
			return strings.ToLower(locations[i].Country) < strings.ToLower(locations[j].Country)
		}
		return strings.ToLower(locations[i].City) < strings.ToLower(locations[j].City)
	})

	return locations
}
