#!/bin/bash
IMPL_4EF=$(bd create --title "Impl: add --version flag to CLI" --type task | grep -o '^[a-zA-Z0-9.-]*')
TEST_4EF=$(bd create --title "[test] add --version flag to CLI" --type task | grep -o '^[a-zA-Z0-9.-]*')
bd dep add gh-toy-4ef apra-pm-7xu
bd dep add apra-pm-7xu $IMPL_4EF
bd dep add apra-pm-7xu $TEST_4EF
bd dep add $TEST_4EF $IMPL_4EF
bd update $IMPL_4EF --set-metadata model=cheap
bd update $TEST_4EF --set-metadata model=cheap
bd update $IMPL_4EF --set-metadata bucket=S
bd update $TEST_4EF --set-metadata bucket=S

IMPL_7RP=$(bd create --title "Impl: help system and input validation" --type task | grep -o '^[a-zA-Z0-9.-]*')
TEST_7RP=$(bd create --title "[test] help system and input validation" --type task | grep -o '^[a-zA-Z0-9.-]*')
bd dep add gh-toy-7rp apra-pm-ith
bd dep add apra-pm-ith $IMPL_7RP
bd dep add apra-pm-ith $TEST_7RP
bd dep add $TEST_7RP $IMPL_7RP
bd update $IMPL_7RP --set-metadata model=standard
bd update $TEST_7RP --set-metadata model=standard
bd update $IMPL_7RP --set-metadata bucket=M
bd update $TEST_7RP --set-metadata bucket=M

IMPL_MI2=$(bd create --title "Impl: CLI CRUD commands" --type task | grep -o '^[a-zA-Z0-9.-]*')
TEST_MI2=$(bd create --title "[test] CLI CRUD commands" --type task | grep -o '^[a-zA-Z0-9.-]*')
bd dep add gh-toy-mi2 apra-pm-gul
bd dep add apra-pm-gul $IMPL_MI2
bd dep add apra-pm-gul $TEST_MI2
bd dep add $TEST_MI2 $IMPL_MI2
bd update $IMPL_MI2 --set-metadata model=premium
bd update $TEST_MI2 --set-metadata model=premium
bd update $IMPL_MI2 --set-metadata bucket=L
bd update $TEST_MI2 --set-metadata bucket=L
