package store

type Store struct{ items []string }

func Open() *Store { return &Store{} }

func (s *Store) Add(v string) { s.items = append(s.items, v); s.flush() }

func (s *Store) flush() {}
