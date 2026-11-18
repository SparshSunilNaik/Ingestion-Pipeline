package server

import "net/http"

type Server struct {
	addr string
}

func New(addr string) *Server {
	return &Server{addr: addr}
}

func (s *Server) Run() error {
	s.log("starting")
	return http.ListenAndServe(s.addr, nil)
}

func (s *Server) Health(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func (s *Server) log(msg string) {}
