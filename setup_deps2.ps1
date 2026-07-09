$FEAT_4EF = bd create --title "Feature for 4ef" --type feature --parent gh-toy-4ef --silent
$IMPL_4EF = bd create --title "Impl 4ef" --type task --parent $FEAT_4EF --silent
$TEST_4EF = bd create --title "[test] 4ef" --type task --parent $FEAT_4EF --silent
bd dep add gh-toy-4ef $FEAT_4EF
bd dep add $FEAT_4EF $IMPL_4EF
bd dep add $FEAT_4EF $TEST_4EF
bd dep add $TEST_4EF $IMPL_4EF
bd update $IMPL_4EF --set-metadata model=cheap
bd update $TEST_4EF --set-metadata model=cheap
bd update $IMPL_4EF --set-metadata bucket=S
bd update $TEST_4EF --set-metadata bucket=S

$FEAT_7RP = bd create --title "Feature for 7rp" --type feature --parent gh-toy-7rp --silent
$IMPL_7RP = bd create --title "Impl 7rp" --type task --parent $FEAT_7RP --silent
$TEST_7RP = bd create --title "[test] 7rp" --type task --parent $FEAT_7RP --silent
bd dep add gh-toy-7rp $FEAT_7RP
bd dep add $FEAT_7RP $IMPL_7RP
bd dep add $FEAT_7RP $TEST_7RP
bd dep add $TEST_7RP $IMPL_7RP
bd update $IMPL_7RP --set-metadata model=standard
bd update $TEST_7RP --set-metadata model=standard
bd update $IMPL_7RP --set-metadata bucket=M
bd update $TEST_7RP --set-metadata bucket=M

$FEAT_MI2 = bd create --title "Feature for mi2" --type feature --parent gh-toy-mi2 --silent
$IMPL_MI2 = bd create --title "Impl mi2" --type task --parent $FEAT_MI2 --silent
$TEST_MI2 = bd create --title "[test] mi2" --type task --parent $FEAT_MI2 --silent
bd dep add gh-toy-mi2 $FEAT_MI2
bd dep add $FEAT_MI2 $IMPL_MI2
bd dep add $FEAT_MI2 $TEST_MI2
bd dep add $TEST_MI2 $IMPL_MI2
bd update $IMPL_MI2 --set-metadata model=premium
bd update $TEST_MI2 --set-metadata model=premium
bd update $IMPL_MI2 --set-metadata bucket=L
bd update $TEST_MI2 --set-metadata bucket=L

bd ready
