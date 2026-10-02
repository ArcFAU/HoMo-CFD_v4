import star.base.neo.DoubleVector;
import star.common.*;
import star.vis.*;

import java.io.*;
import java.text.DecimalFormat;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class postprocessing extends StarMacro {

    private Simulation simulation_0;
    private final String postprocessing="xyz3";
    private String dirPath;
    private String directory;
    private DecimalFormat df;
    private Units units_mm;
    private int xStart, xEnd, xResolution;
    private ArrayList<Scene> xSections;
    private ArrayList<Scene> ySections;
    private ArrayList<Scene> zSections;
    private ArrayList<Scene> threeDscenes;
    private ArrayList<String> pressureDistributions;

    private ArrayList<String> plots;
    private int yStart, yEnd, yResolution;
    private int zStart, zEnd, zResolution;
    private boolean step = false;




    private void LIC() {

        Simulation simulation_0 =
                getActiveSimulation();

        Scene scene_6 =
                simulation_0.getSceneManager().getScene("Velocity");

        VectorDisplayer vectorDisplayer_2 =
                ((VectorDisplayer) scene_6.getDisplayerManager().getObject("x-Section"));

        vectorDisplayer_2.setDisplayMode(VectorDisplayMode.VECTOR_DISPLAY_MODE_LIC);

        VectorDisplayer vectorDisplayer_0 =
                ((VectorDisplayer) scene_6.getDisplayerManager().getObject("y-Section"));

        vectorDisplayer_0.setDisplayMode(VectorDisplayMode.VECTOR_DISPLAY_MODE_LIC);

        VectorDisplayer vectorDisplayer_3 =
                ((VectorDisplayer) scene_6.getDisplayerManager().getObject("z-Section"));

        vectorDisplayer_3.setDisplayMode(VectorDisplayMode.VECTOR_DISPLAY_MODE_LIC);
    }






    @Override
    public void execute() {

        LIC();

        simulation_0 = this.getActiveSimulation();
        directory = simulation_0.getSessionDir();
        df = new DecimalFormat("000");
        units_mm= simulation_0.getUnitsManager().getObject("mm");

        xSections = new ArrayList<>();
        ySections = new ArrayList<>();
        zSections = new ArrayList<>();
        threeDscenes = new ArrayList<>();
        plots = new ArrayList<>();
        pressureDistributions = new ArrayList<>();

        try {
            var br = new BufferedReader(new FileReader(directory+"/Settings"));
            String line;
            while ((line = br.readLine()) != null) {
                String[] parts = line.split(" : ");
                if (parts.length > 1) {
                    String name = parts[0].trim();
                    String value = parts[1].trim();

                    if (name.equals("Scenes/x-Sections/Range/Start")) {
                        xStart = (int) Double.parseDouble(value);
                    } else if (name.equals("Scenes/x-Sections/Range/End")) {
                        xEnd = (int) Double.parseDouble(value);
                    } else if (name.equals("Scenes/x-Sections/Range/Resolution")) {
                        xResolution = (int) Double.parseDouble(value);
                    } else if (name.equals("Scenes/y-Sections/Range/Start")) {
                        yStart = (int) Double.parseDouble(value);
                    } else if (name.equals("Scenes/y-Sections/Range/End")) {
                        yEnd = (int) Double.parseDouble(value);
                    } else if (name.equals("Scenes/y-Sections/Range/Resolution")) {
                        yResolution = (int) Double.parseDouble(value);
                    } else if (name.equals("Scenes/z-Sections/Range/Start")) {
                        zStart = (int) Double.parseDouble(value);
                    } else if (name.equals("Scenes/z-Sections/Range/End")) {
                        zEnd = (int) Double.parseDouble(value);
                    } else if (name.equals("Scenes/z-Sections/Range/Resolution")) {
                        zResolution = (int) Double.parseDouble(value);
                    }
                    else if(name.equals("Run Remote Delete Time"))
                    {
                        try {
                            FileWriter fileWriter = new FileWriter(simulation_0.getSessionDir()+"/deleteDate.txt");
                            LocalDate tomorrow = LocalDate.now().plusDays((int) (Double.parseDouble(value)));
                            DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
                            String date = tomorrow.format(formatter);
                            fileWriter.write(date);
                            fileWriter.close();
                        } catch (IOException e) {

                        }
                    }



                    if(Boolean.parseBoolean(value))
                    {
                        String[] path = name.split("/");
                        if (name.contains("Pressure Distribution"))
                        {
                            pressureDistributions.add(path[path.length-1]);
                        }
                        else if (name.contains("x-Section"))
                        {
                            xSections.add(simulation_0.getSceneManager().getScene(path[path.length-1]));
                        }
                        else if (name.contains("y-Section"))
                        {
                            ySections.add(simulation_0.getSceneManager().getScene(path[path.length-1]));
                        }
                        else if (name.contains("z-Section"))
                        {
                            zSections.add(simulation_0.getSceneManager().getScene(path[path.length-1]));
                        }
                        else if (name.contains("3D-Scenes"))
                        {
                            threeDscenes.add(simulation_0.getSceneManager().getScene(path[path.length-1]));
                        }
                        else if (name.contains("plots"))
                        {
                            plots.add(path[path.length-1]);
                        }
                        if(name.contains("Inspection"))
                        {
                            step=true;
                        }
                    }
                }
            }

        } catch (FileNotFoundException e) {
            throw new RuntimeException(e);
        } catch (IOException e) {
            throw new RuntimeException(e);
        }

        if(step)
        {
            simulation_0.getSimulationIterator().step(1);
        }


        PlaneSection planeSection_x =
                ((PlaneSection) simulation_0.getPartManager().getObject("plane section x-direction"));
        PlaneSection planeSection_y =
                ((PlaneSection) simulation_0.getPartManager().getObject("plane section y-direction"));
        PlaneSection planeSection_z =
                ((PlaneSection) simulation_0.getPartManager().getObject("plane section z-direction"));

        ExecutorService executorService = Executors.newFixedThreadPool(20);


        int counter =0;

        if(postprocessing.contains("y")) {
            for (Scene scene : ySections) {
                if (scene.getDisplayerManager().hasDisplayer("3D")) {
                    Displayer displayer = (Displayer) scene.getDisplayerManager().getObject("3D");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
                }
                if (scene.getDisplayerManager().hasDisplayer("y-Section")) {
                    Displayer displayer = (Displayer) scene.getDisplayerManager().getObject("x-Section");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
                    displayer = (Displayer) scene.getDisplayerManager().getObject("y-Section");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.SHOW_ALL_PARTS);
                    displayer.getInputParts().setQuery(null);
                    displayer.getInputParts().setObjects(planeSection_y);
                    displayer = (Displayer) scene.getDisplayerManager().getObject("z-Section");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
                }
                if (scene.getDisplayerManager().hasDisplayer("y-Section-outline")) {
                    Displayer displayer = (Displayer) scene.getDisplayerManager().getObject("x-Section-outline");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
                    displayer = (Displayer) scene.getDisplayerManager().getObject("y-Section-outline");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.SHOW_ALL_PARTS);
                    displayer = (Displayer) scene.getDisplayerManager().getObject("z-Section-outline");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
                }
                CurrentView currentView =
                        scene.getCurrentView();
                currentView.setInput(new DoubleVector(new double[]{0.8, 0.0, 0.7}), new DoubleVector(new double[]{0.8, 1.0, 0.7}), new DoubleVector(new double[]{0.0, 0.0, 1.0}), 1.0, 1, 30.0);
            }
            counter = 0;
            for (int i = yStart; i < yEnd; i += yResolution) {
                counter += 1;
                final int counterF = counter;
                CountDownLatch latch = new CountDownLatch(ySections.size());
                int finalI = i;
                double y = i * 0.001;
                planeSection_y.getOriginCoordinate().setDefinition("[0.0 ," + y + ", 0.0]");
                for (Scene scene : ySections) {
                    executorService.submit(() -> {
                        //  Sie Ihre Methode hier aus
                        export(scene, "y-Section", counterF, finalI);
                        latch.countDown();
                        scene.getRenderCanvas().createImage(100,200);
                    });
                }

                try {
                    latch.await();
                } catch (InterruptedException e) {
                    // Behandeln Sie die Ausnahme
                }
            }
        }
		
        if(postprocessing.contains("x")) {


            for (Scene scene : xSections) {
                if (scene.getDisplayerManager().hasDisplayer("3D")) {
                    Displayer displayer = (Displayer) scene.getDisplayerManager().getObject("3D");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
                }
                if (scene.getDisplayerManager().hasDisplayer("x-Section")) {
                    Displayer displayer = (Displayer) scene.getDisplayerManager().getObject("x-Section");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.SHOW_ALL_PARTS);
                    displayer.getInputParts().setQuery(null);
                    displayer.getInputParts().setObjects(planeSection_x);
                    displayer = (Displayer) scene.getDisplayerManager().getObject("y-Section");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
                    displayer = (Displayer) scene.getDisplayerManager().getObject("z-Section");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
                }
                if (scene.getDisplayerManager().hasDisplayer("x-Section-outline")) {
                    Displayer displayer = (Displayer) scene.getDisplayerManager().getObject("x-Section-outline");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.SHOW_ALL_PARTS);
                    displayer = (Displayer) scene.getDisplayerManager().getObject("y-Section-outline");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
                    displayer = (Displayer) scene.getDisplayerManager().getObject("z-Section-outline");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
                }

                CurrentView currentView =
                        scene.getCurrentView();
                currentView.setInput(new DoubleVector(new double[]{0.0, 0.00, 0.6}), new DoubleVector(new double[]{1.0, 0.0, 0.6}), new DoubleVector(new double[]{0.0, 0.0, 1.0}), 0.8, 1, 30.0);
            }
            counter =0;
            for (int i = xStart; i > xEnd; i -= xResolution) {
                counter += 1;
                final int counterF = counter;
                CountDownLatch latch = new CountDownLatch(xSections.size());
                int finalI = i;
                double x = i * 0.001;


                planeSection_x.getOriginCoordinate().setDefinition("[" + x + ", 0.0, 0.0]");

                for (Scene scene : xSections) {
                    executorService.submit(() -> {
                        //  Sie Ihre Methode hier aus
                        export(scene, "x-Section", counterF, finalI);
                        latch.countDown();
                    });
                }
                try {
                    latch.await();
                } catch (InterruptedException e) {
                    // Behandeln Sie die Ausnahme
                }
            }
        }

        if(postprocessing.contains("z")) {
            for (Scene scene : zSections) {
                if (scene.getDisplayerManager().hasDisplayer("3D")) {
                    Displayer displayer = (Displayer) scene.getDisplayerManager().getObject("3D");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
                }
                if (scene.getDisplayerManager().hasDisplayer("z-Section")) {
                    Displayer displayer = (Displayer) scene.getDisplayerManager().getObject("x-Section");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
                    displayer = (Displayer) scene.getDisplayerManager().getObject("y-Section");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
                    displayer = (Displayer) scene.getDisplayerManager().getObject("z-Section");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.SHOW_ALL_PARTS);
                    displayer.getInputParts().setQuery(null);
                    displayer.getInputParts().setObjects(planeSection_z);
                }
                if (scene.getDisplayerManager().hasDisplayer("z-Section-outline")) {
                    Displayer displayer = (Displayer) scene.getDisplayerManager().getObject("x-Section-outline");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
                    displayer = (Displayer) scene.getDisplayerManager().getObject("y-Section-outline");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
                    displayer = (Displayer) scene.getDisplayerManager().getObject("z-Section-outline");
                    displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.SHOW_ALL_PARTS);
                }


                CurrentView currentView =
                        scene.getCurrentView();
                currentView.setInput(new DoubleVector(new double[]{0.7, 0.00, 0.0}), new DoubleVector(new double[]{0.7, 0.00, -1.0}), new DoubleVector(new double[]{0.0, 1.0, 0.0}), 1.20, 1, 30.0);
            }
            counter = 0;
            for (int i = zStart; i < zEnd; i += zResolution) {
                counter += 1;
                final int counterF = counter;
                CountDownLatch latch = new CountDownLatch(zSections.size());
                int finalI = i;
                double z = i * 0.001;
                planeSection_z.getOriginCoordinate().setDefinition("[0.0, 0.0," + z + "]");
                for (Scene scene : zSections) {
                    executorService.submit(() -> {
                        //  Sie Ihre Methode hier aus
                        export(scene, "z-Section", counterF, finalI);
                        latch.countDown();
                    });
                }

                try {
                    latch.await();
                } catch (InterruptedException e) {
                    // Behandeln Sie die Ausnahme
                }
            }
        }

        if(postprocessing.contains("3"))
        {
            for(String plotName : pressureDistributions)
            {
                exportPressureDistribution(plotName);
            }
            for (String plotName : plots)
            {
                StarPlot plot = simulation_0.getPlotManager().getPlot(plotName);
                plot.encode("plots/"+plotName);
            }
            for (Scene three : threeDscenes) {
                //executorService.submit(() -> {
                exportThree(three);
                //});
            }
            // Surfaces with Cp fields for HoMo CFD's 3D viewer (3D-data/), see export3D.java.
            export3DData();
        }
        executorService.shutdown();



    }


    private void export(Scene scene,String section,int counter, int i)
    {

        int xRes=3000;
        int yRes=1600;
        /*
        if(scene.getPresentationName().equals("Velocity"))
        {
            xRes=2*xRes;
            yRes=2*yRes;
        }
         */

        scene.printToFile(new File(scene.getPresentationName()+"_"+section + "/" + df.format(counter) + "_" + scene.getPresentationName()+"_" + section + "_" + i + "mm.png"),xRes,yRes);

    }

    // Plays export3D.java from the case folder when it is there. Any problem is only
    // logged, so the rest of the post-processing always runs.
    private void export3DData()
    {
        File macro = new File(directory, "export3D.java");
        if (!macro.isFile()) {
            return;
        }
        try {
            new StarScript(getActiveRootObject(), macro).play();
        } catch (Throwable e) {
            simulation_0.println("3D export skipped: " + e);
        }
    }

    private void exportThree(Scene scene)
    {

        if (scene.getDisplayerManager().hasDisplayer("3D")) {
            Displayer threeDisplayer = (Displayer) scene.getDisplayerManager().getObject("3D");
            threeDisplayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.SHOW_ALL_PARTS);
        }
        if (scene.getDisplayerManager().hasDisplayer("x-Section")) {
            Displayer displayer = (Displayer) scene.getDisplayerManager().getObject("x-Section");
            displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
            displayer = (Displayer) scene.getDisplayerManager().getObject("y-Section");
            displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
            displayer = (Displayer) scene.getDisplayerManager().getObject("z-Section");
            displayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.HIDE_ALL_PARTS);
        }
        



        CurrentView currentView_0 =
                scene.getCurrentView();


        scene.setViewOrientation(new DoubleVector(new double[] {-0.0, -0.0, -1.0}), new DoubleVector(new double[] {0.0, 1.0, 0.0}));

        currentView_0.setInput(new DoubleVector(new double[] {1.0433309257839718, -0.3437325385786574, 0.1811016102448635}), new DoubleVector(new double[] {1.0433309257839718, -0.3437325385786574, -4.007088149158675}), new DoubleVector(new double[] {0.0, 1.0, 0.0}), 0.9086111661279132, 1, 30.0);

        scene.printAndWait(resolvePath("3D/"+scene.getPresentationName()+"_z-Section.png"), 1, 3000, 1600, true, false);

        scene.setViewOrientation(new DoubleVector(new double[] {0.0, -1.0, 0.0}), new DoubleVector(new double[] {0.0, 0.0, 1.0}));

        currentView_0.setInput(new DoubleVector(new double[] {0.9373451887261087, -0.6889730471905384, 0.5264448251116707}), new DoubleVector(new double[] {0.9373451887261087, -5.76690080241168, 0.5264448251116707}), new DoubleVector(new double[] {0.0, 0.0, 1.0}), 0.9086111661279132, 1, 30.0);

        scene.printAndWait(resolvePath("3D/"+scene.getPresentationName()+"_y-Section.png"), 1, 3000, 1600, true, false);

        currentView_0.setInput(new DoubleVector(new double[] {0.9459035356598096, -0.283824110042751, 0.5264448251116707}), new DoubleVector(new double[] {0.9459035356598096, -5.76690080241168, 0.5264448251116707}), new DoubleVector(new double[] {0.0, 0.0, 1.0}), 0.9086111661279132, 1, 30.0);

        scene.setViewOrientation(new DoubleVector(new double[] {-1.0, 0.0, 0.0}), new DoubleVector(new double[] {0.0, 0.0, 1.0}));

        scene.printAndWait(resolvePath("3D/"+scene.getPresentationName()+"_x-Section.png"), 1, 3000, 1600, true, false);


        if (scene.getDisplayerManager().hasDisplayer("x-Section")) {
            Displayer xDisplayer = (Displayer) scene.getDisplayerManager().getObject("x-Section");
            Displayer yDisplayer = (Displayer) scene.getDisplayerManager().getObject("y-Section");
            Displayer zDisplayer = (Displayer) scene.getDisplayerManager().getObject("z-Section");
            xDisplayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.SHOW_ALL_PARTS);
            yDisplayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.SHOW_ALL_PARTS);
            zDisplayer.setVisibilityOverrideMode(DisplayerVisibilityOverride.SHOW_ALL_PARTS);
        }

    }

    private void exportPressureDistribution(String name)
    {

        XYPlot plot = ((XYPlot) simulation_0.getPlotManager().getPlot(name));


        PlaneSection planeSection = ((PlaneSection) simulation_0.getPartManager().getObject("fw_y-section"));


        String part = "fw";

        if(name.contains("pd_UT"))
        {
            part = "ut";
        }
        else if(name.contains("pd_RW"))
        {
            part = "rw";
        }

        String section;
        if(name.contains("x-Section"))
        {
            section = "x-Section";
            planeSection =
                    ((PlaneSection) simulation_0.getPartManager().getObject(part+"_x-section"));

            int counter =0;
            for (int i = xStart; i > xEnd; i -= xResolution) {
                counter += 1;
                double x = i * 0.001;

                planeSection.getOriginCoordinate().setDefinition("[" + x + ", 0.0, 0.0]");



                plot.export(resolvePath("PressureDistributions/"+plot.getPresentationName() + "/" + df.format(counter) + "_" + plot.getPresentationName() + "_" + i + "mm.csv"));
                //plot.encode(resolvePath(plot.getPresentationName()+ "_"+section + "/" + df.format(counter) + "_" + plot.getPresentationName()+"_" + section + "_" + i + "mm.png"), "png", 3000, 1600, true, false);

                //plot.encode(resolvePath("Pressure_Distributions/"+plot.getPresentationName()+ "/" + df.format(counter) + "_" + plot.getPresentationName()+ "_" + i + "mm.png"), "png", 1600, 900, true, false);
                //scene.printToFile(new File(scene.getPresentationName()+"_"+section + "/" + df.format(counter) + "_" + scene.getPresentationName()+"_" + section + "_" + i + "mm.png"),xRes,yRes);


            }
        }
        else if(name.contains("y-Section"))
        {
            section = "y-Section";

            planeSection =
                    ((PlaneSection) simulation_0.getPartManager().getObject(part+"_y-section"));

            int counter =0;
            for (int i = yStart; i < yEnd; i += yResolution) {
                counter += 1;
                double y = i * 0.001;

                planeSection.getOriginCoordinate().setDefinition("[0.0,"+ y+", 0.0]");

                //plot.encode(resolvePath("Pressure_Distributions/"+plot.getPresentationName()+ "/" + df.format(counter) + "_" + plot.getPresentationName()+ "_" + i + "mm.png"), "png", 1600, 900, true, false);


                plot.export(resolvePath("PressureDistributions/"+plot.getPresentationName() + "/" + df.format(counter) + "_" + plot.getPresentationName() + "_" + i + "mm.csv"));
                //plot.encode(resolvePath(plot.getPresentationName()+ "_"+section + "/" + df.format(counter) + "_" + plot.getPresentationName()+"_" + section + "_" + i + "mm.png"), "png", 3000, 1600, true, false);

            }
        } else if(name.contains("z-Section"))
        {
            section = "z-Section";

            planeSection =
                    ((PlaneSection) simulation_0.getPartManager().getObject(part+"_z-section"));

            int counter =0;
            for (int i = zStart; i > zEnd; i -= zResolution) {
                counter += 1;
                double z = i * 0.001;

                planeSection.getOriginCoordinate().setDefinition("[0.0, 0.0,"+ z + "]");

                //plot.encode(resolvePath("Pressure_Distributions/"+plot.getPresentationName()+ "/" + df.format(counter) + "_" + plot.getPresentationName()+ "_" + i + "mm.png"), "png", 1600, 900, true, false);


                plot.export(resolvePath("PressureDistributions/"+plot.getPresentationName() + "/" + df.format(counter) + "_" + plot.getPresentationName() + "_" + i + "mm.csv"));
                //plot.encode(resolvePath(plot.getPresentationName()+ "_"+section + "/" + df.format(counter) + "_" + plot.getPresentationName()+"_" + section + "_" + i + "mm.png"), "png", 3000, 1600, true, false);

            }
        }




    }


}

